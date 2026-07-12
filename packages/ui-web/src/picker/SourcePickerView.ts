import { OnceClient } from "@once/app"
import { build_source, sanitize_selector_conf } from "@once/collectors/geny"
import { SettingsPanel } from "../SettingsPanel"

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
  private static startPicker: (() => Promise<string | null>) | null = null
  private static listening = false
  private static busy = false

  static mount(
    client: OnceClient,
    startPicker?: () => Promise<string | null>
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
        await runtime.sendMessage({ onceCommand: "startSourcePicker" })
        SourcePickerView.setStatus("Pick the story elements on the page.")
      } catch (error) {
        SourcePickerView.showError(error)
      }
      return
    }
    if (!SourcePickerView.startPicker) {
      SourcePickerView.setStatus("Source picking is not available here.")
      return
    }
    SourcePickerView.busy = true
    const label = button.value
    button.disabled = true
    button.value = "picking…"
    try {
      const source = await SourcePickerView.startPicker()
      if (source) await SourcePickerView.addSource(source)
    } catch (error) {
      SourcePickerView.showError(error)
    } finally {
      SourcePickerView.busy = false
      button.disabled = false
      button.value = label
    }
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
  }

  private static setStatus(text: string): void {
    const status = document.querySelector<HTMLElement>("#pick_source_status")
    if (status) status.textContent = text
  }
}
