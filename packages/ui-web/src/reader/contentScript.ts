import "webextension-polyfill"
import { extractArticle } from "./extractArticle"
import { readerDocument, ReaderTheme } from "./readerDocument"
import {
  installReaderDocument,
  installReaderPageTts,
  showReaderPageError
} from "./readerPageRuntime"

async function render(): Promise<void> {
  const sourceUrl = location.href
  const configured = document.documentElement.getAttribute("data-once-reader-theme")
  document.documentElement.removeAttribute("data-once-reader-theme")
  const theme: ReaderTheme = configured === "light" || configured === "dark"
    ? configured
    : "system"
  try {
    const article = extractArticle(document.documentElement.outerHTML, sourceUrl)
    installReaderDocument(readerDocument(article, theme))
    await installReaderPageTts()
  } catch (error) {
    showReaderPageError(error)
  }
}

void render()
