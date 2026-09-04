// Entry for the extension's own reader page: the panel rendered a stored
// article into a reader document, the background parked it under a token, and
// this page asks for it back and installs it. No request leaves the browser,
// which is what lets a saved story read offline.
import browser from "webextension-polyfill"
import {
  installReaderDocument,
  installReaderPageTts,
  showReaderPageError
} from "@once/ui-web/reader/readerPageRuntime"

async function render(): Promise<void> {
  try {
    const token = new URLSearchParams(location.search).get("token")
    if (!token) throw new Error("This reader page was opened without a story")
    const stored = await browser.runtime.sendMessage({
      onceCommand: "getStoredReader",
      token
    }) as { html?: string } | undefined
    if (!stored?.html) {
      throw new Error("This reader page has expired; open the story again")
    }
    installReaderDocument(stored.html)
    await installReaderPageTts()
  } catch (error) {
    showReaderPageError(error)
  }
}

void render()
