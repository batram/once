import { fetchDocument } from "@once/app/documents"
import { createPdfTextPort } from "@once/platform-web/pdf"
import { readerDocument } from "@once/ui-web/reader/readerDocument"
import { extractArticle } from "@once/ui-web/reader/extractArticle"
// Entry for the extension's own reader page: the panel rendered a stored
// article into a reader document, the background parked it under a token, and
// this page asks for it back and installs it. No request leaves the browser,
// which is what lets a saved story read offline. PDF sources instead extract
// locally here, outside the browser's privileged PDF viewer.
import browser from "webextension-polyfill"
import {
  installReaderDocument,
  installReaderPageTts,
  showReaderPageError
} from "@once/ui-web/reader/readerPageRuntime"

async function render(): Promise<void> {
  try {
    const params = new URLSearchParams(location.search)
    if (params.get("pdf") === "1") {
      const status = document.createElement("p")
      status.setAttribute("role", "status")
      status.textContent = "Preparing PDF reader…"
      document.body.append(status)
      const sourceUrl = params.get("sourceUrl") || ""
      const fetched = await fetchDocument(fetch, sourceUrl, undefined, createPdfTextPort({ sandboxUrl: browser.runtime.getURL("static/pdf-sandbox.html") }))
      const article = extractArticle(fetched.html, fetched.url, fetched.mediaType)
      const theme = params.get("theme")
      installReaderDocument(readerDocument({ ...article, sourceUrl }, theme === "dark" || theme === "light" ? theme : "system"))
      await installReaderPageTts(browser.runtime)
      return
    }
    const token = params.get("token")
    if (!token) throw new Error("This reader page was opened without a story")
    const stored = await browser.runtime.sendMessage({
      onceCommand: "getStoredReader",
      token
    }) as { html?: string } | undefined
    if (!stored?.html) {
      throw new Error("This reader page has expired; open the story again")
    }
    installReaderDocument(stored.html)
    await installReaderPageTts(browser.runtime)
  } catch (error) {
    showReaderPageError(error, new URLSearchParams(location.search).get("sourceUrl") ?? location.href, browser.runtime)
  }
}

void render()
