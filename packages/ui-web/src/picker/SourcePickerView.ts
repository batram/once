import { OnceClient } from "@once/app"
import { build_source, sanitize_selector_conf } from "@once/collectors/geny"
import { SettingsPanel } from "../SettingsPanel"
import { LoaderInsights } from "../LoaderInsights"
import { showTextInputDialog } from "../ConfirmDialog"

declare const browser: {
  runtime?: {
    sendMessage(message: unknown): Promise<unknown>
    onMessage: {
      addListener(
        listener: (message: PickedMessage, sender: unknown) => undefined
      ): void
    }
  }
}

interface PickedMessage {
  onceCommand?: string
  conf?: string | null
  url?: string | null
}

// Shared entry point for creating a geny_match source from a live page. In
// the extensions the pick runs as a content script on the active browser tab
// and reports back through runtime messages; on Electron the composition
// root supplies a starter that resolves with the finished source line.
export class SourcePickerView {
  private static client: OnceClient | null = null
  private static startPicker:
    ((url?: string) => Promise<string | null>) | null = null
  private static listening = false
  private static busy = false

  static mount(
    client: OnceClient,
    startPicker?: (url?: string) => Promise<string | null>
  ): void {
    SourcePickerView.client = client
    if (startPicker) SourcePickerView.startPicker = startPicker
    SourcePickerView.listen()
    const button = document.querySelector<HTMLInputElement>(
      "#pick_source_button"
    )
    if (button) {
      button.onclick = () => {
        void SourcePickerView.pick(button)
      }
    }
  }

  private static async pick(button: HTMLInputElement): Promise<void> {
    if (SourcePickerView.busy) return
    SourcePickerView.setStatus("")
    const runtime = SourcePickerView.webExtensionRuntime()
    if (runtime) {
      try {
        const result = await runtime.sendMessage({ onceCommand: "startSourcePicker" })
        if ((result as { needsUrl?: boolean } | undefined)?.needsUrl) {
          const url = await SourcePickerView.requestUrl()
          if (!url) return
          await runtime.sendMessage({ onceCommand: "startSourcePicker", url })
        }
        SourcePickerView.setStatus("Pick the story elements on the page.")
      } catch (error) {
        SourcePickerView.showError(error)
      }
      return
    }
    SourcePickerView.busy = true
    const label = button.value
    button.disabled = true
    button.value = "picking…"
    try {
      let source: string | null
      if (SourcePickerView.startPicker) {
        source = await SourcePickerView.startPicker()
      } else {
        const url = await SourcePickerView.requestUrl()
        if (!url) return
        throw new Error("Source picking is not available on this device")
      }
      if (source) await SourcePickerView.addSource(source)
    } catch (error) {
      if (SourcePickerView.startPicker &&
          /no active tab|needs an HTTP or HTTPS page/i.test(String(error))) {
        try {
          const url = await SourcePickerView.requestUrl()
          if (!url) return
          const source = await SourcePickerView.startPicker(url)
          if (source) await SourcePickerView.addSource(source)
        } catch (fallbackError) {
          SourcePickerView.showError(fallbackError)
        }
      } else {
        SourcePickerView.showError(error)
      }
    } finally {
      SourcePickerView.busy = false
      button.disabled = false
      button.value = label
    }
  }

  private static async requestUrl(): Promise<string | null> {
    const value = await showTextInputDialog({
      message: "Enter the URL of the page to pick story elements from.",
      value: "https://",
      confirmLabel: "Open and pick",
      positionWithin: document.querySelector<HTMLElement>("#settings_panel") || undefined
    })
    if (value === null) return null
    const candidate = value.trim()
    if (!candidate) return null
    const normalized = /^[a-z][a-z\d+.-]*:/i.test(candidate)
      ? candidate
      : `https://${candidate}`
    const url = new URL(normalized)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Source picking needs an HTTP or HTTPS URL")
    }
    return url.href
  }

  private static listen(): void {
    const runtime = SourcePickerView.webExtensionRuntime()
    if (SourcePickerView.listening || !runtime) return
    SourcePickerView.listening = true
    runtime.onMessage.addListener((message) => {
      if (message?.onceCommand !== "sourcePicked") return undefined
      if (!message.conf || !message.url) return undefined
      void SourcePickerView.handlePicked(message.conf, message.url).catch(
        (error) => SourcePickerView.showError(error)
      )
      return undefined
    })
  }

  private static async handlePicked(confJson: string, url: string): Promise<void> {
    const conf = sanitize_selector_conf(JSON.parse(confJson))
    await SourcePickerView.addSource(build_source(conf, url))
  }

  private static async addSource(source: string): Promise<void> {
    const client = SourcePickerView.client
    if (!client) throw new Error("SourcePickerView has not been mounted")
    const sources = await client.getStorySources()
    if (!sources.includes(source)) {
      await client.saveStorySources([...sources, source])
    }
    SourcePickerView.setStatus("")
    SettingsPanel.instance?.highlightSource(source)
  }

  private static webExtensionRuntime(): NonNullable<typeof browser.runtime> | undefined {
    if (typeof browser === "undefined" || !browser.runtime?.sendMessage) {
      return undefined
    }
    return browser.runtime
  }

  private static showError(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    SourcePickerView.setStatus(`Source picking failed: ${detail}`)
    LoaderInsights.showErrorMessage(
      `Source picking failed: ${detail}`,
      `Operation: source-picker\n\n${
        error instanceof Error ? error.stack || error.message : String(error)
      }`
    )
  }

  private static setStatus(text: string): void {
    const status = document.querySelector<HTMLElement>("#pick_source_status")
    if (status) status.textContent = text
  }
}
