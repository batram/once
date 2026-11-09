import { MAX_DOCUMENT_BYTES } from "@once/app"
import { LIVE_PAGE_SCRIPT, readLivePage, sameDocumentUrl } from "@once/app/livePage"
import type { ReadingTabRuntime } from "./readingTabRuntime"

/**
 * The page a tab holds for `url`, as that tab rendered it. Reader mode covers
 * the page it was asked for, so the copy behind the reader counts as much as
 * one on screen: a site behind a bot challenge serves the tab and refuses the
 * reader's own download. Never opens or navigates anything, and the page says
 * itself which address it is at, so one that moved on meanwhile is not taken
 * for the one asked for.
 */
export async function livePageHtml(runtime: ReadingTabRuntime, url: string): Promise<{ html: string; url: string } | null> {
  const surface = runtime.surfaceShowing(url)
  if (!surface) return null
  const page = readLivePage(await surface.evaluateJavaScript(LIVE_PAGE_SCRIPT).catch(() => null))
  return page && sameDocumentUrl(page.url, url) ? page : null
}

/**
 * The PDF a tab's viewer shows, for the same reason. A viewer reports its load
 * differently per engine, so the native side checks that its page finished
 * loading this URL as a PDF; without a tab known to hold it, the selected one
 * is asked.
 */
export async function livePagePdf(runtime: ReadingTabRuntime, url: string): Promise<{ bytes: Uint8Array; url: string } | null> {
  if (!runtime.tabs.selected) return null
  const surface = runtime.surfaceShowing(url) ?? runtime.pageSurface
  return await surface.pdfBytes?.(url, MAX_DOCUMENT_BYTES) ?? null
}
