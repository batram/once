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
      const stored = await browser.storage.local.get("onceReaderTtsRate")
      const parsedRate = Number(stored.onceReaderTtsRate)
      if (Number.isFinite(parsedRate)) initialRate = parsedRate
    } catch {
      // TTS remains available with defaults when extension storage is unavailable.
    }
    installReaderTts({
      initialRate,
      onRateChange: (rate) => {
        void browser.storage.local.set({ onceReaderTtsRate: rate })
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
