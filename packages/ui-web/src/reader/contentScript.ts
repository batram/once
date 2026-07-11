import "webextension-polyfill"
import { extractArticle } from "./extractArticle"
import { readerDocument, ReaderTheme } from "./readerDocument"
import { installReaderTts } from "./readerTts"

async function render(): Promise<void> {
  const sourceUrl = location.href
  const configured = document.documentElement.getAttribute("data-once-reader-theme")
  document.documentElement.removeAttribute("data-once-reader-theme")
  const theme: ReaderTheme = configured === "light" || configured === "dark"
    ? configured
    : "system"
  try {
    const article = extractArticle(document.documentElement.outerHTML, sourceUrl)
    const rendered = new DOMParser().parseFromString(
      readerDocument(article, theme),
      "text/html"
    )
    const replacement = document.importNode(rendered.documentElement, true)
    document.replaceChild(replacement, document.documentElement)
    let initialRate = 1
    try {
      const stored = await browser.runtime.sendMessage({
        onceCommand: "getReaderTtsRate"
      }) as { rate?: unknown }
      const parsedRate = Number(stored?.rate)
      if (Number.isFinite(parsedRate)) initialRate = parsedRate
    } catch {
      // TTS remains available with defaults when extension storage is unavailable.
    }
    installReaderTts({
      initialRate,
      onRateChange: (rate) => {
        void browser.runtime.sendMessage({
          onceCommand: "setReaderTtsRate",
          rate
        }).catch((error) => {
          console.warn("Unable to save reader TTS speed", error)
        })
      },
      claimOwnership: () => {
        void browser.runtime
          .sendMessage({ onceCommand: "claimReaderTts" })
          .catch(() => undefined)
      },
      releaseOwnership: () => {
        void browser.runtime
          .sendMessage({ onceCommand: "releaseReaderTts" })
          .catch(() => undefined)
      },
      subscribeToStop: (handler) => {
        const listener = (message: { onceCommand?: string }) => {
          if (message?.onceCommand === "stopReaderTts") handler()
        }
        browser.runtime.onMessage.addListener(listener)
        return () => browser.runtime.onMessage.removeListener(listener)
      }
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const message = document.createElement("div")
    message.className = "once-reader-error"
    message.setAttribute("role", "alert")
    message.textContent = `Reader mode failed: ${detail}`
    document.body.prepend(message)
    message.scrollIntoView({ block: "start" })
    console.error("Reader mode failed", error)
  }
}

void render()
