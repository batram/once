// What the extension reader surfaces share once they hold a rendered reader
// document: the live page's content script (which built it from the page) and
// the reader page (which received it from the panel). Both run under the
// extension's `browser.runtime`, so the speech controls talk to the background
// the same way.

import { installReaderTts } from "./readerTts"
import {
  emptyReaderTtsPreferences,
  normalizeReaderTtsPreferences
} from "./readerTtsPreferences"

/** Swaps the current document for the rendered reader document. */
export function installReaderDocument(html: string): void {
  const rendered = new DOMParser().parseFromString(html, "text/html")
  const replacement = document.importNode(rendered.documentElement, true)
  document.replaceChild(replacement, document.documentElement)
}

/**
 * Wires the reader's speech controls to the background: the stored voice and
 * speeds, and ownership so two reader tabs do not read aloud at once.
 */
export async function installReaderPageTts(): Promise<void> {
  let preferences = emptyReaderTtsPreferences()
  try {
    preferences = normalizeReaderTtsPreferences(await browser.runtime.sendMessage({
      onceCommand: "getReaderTtsPreferences"
    }))
  } catch {
    // TTS remains available with defaults when extension storage is unavailable.
  }
  installReaderTts({
    preferences,
    wafli: { wasmUrl: browser.runtime.getURL("static/wafli-module.wasm") },
    onPreferencesChange: (changed) => {
      void browser.runtime.sendMessage({
        onceCommand: "setReaderTtsPreferences",
        preferences: changed
      }).catch((error) => {
        console.warn("Unable to save reader TTS settings", error)
      })
    },
    claimOwnership: () => {
      void browser.runtime
        .sendMessage({ onceCommand: "claimReaderTts" })
        .catch((): void => undefined)
    },
    releaseOwnership: () => {
      void browser.runtime
        .sendMessage({ onceCommand: "releaseReaderTts" })
        .catch((): void => undefined)
    },
    subscribeToStop: (handler) => {
      const listener = (message: { onceCommand?: string }) => {
        if (message?.onceCommand === "stopReaderTts") handler()
      }
      browser.runtime.onMessage.addListener(listener)
      return () => browser.runtime.onMessage.removeListener(listener)
    }
  })
}

export function showReaderPageError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  const message = document.createElement("div")
  message.className = "once-reader-error"
  message.setAttribute("role", "alert")
  message.textContent = `Reader mode failed: ${detail}`
  document.body.prepend(message)
  message.scrollIntoView({ block: "start" })
  console.error("Reader mode failed", error)
}
