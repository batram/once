import type { WebContents } from "electron"

interface TabLike { id: string; url: string; loadError: string | null }
interface TabWindow<Entry> {
  getAll(window: Entry): TabLike[]
  tabContents(window: Entry, id: string): WebContents
}

/** Anything larger is not an article; a tab's DOM can be a whole application. */
const MAX_PAGE_HTML = 8 * 1024 * 1024

/**
 * The page as the tab shows it, after its scripts ran: what a reader would
 * see where a fetch finds only what the server sent. Only a finished load of
 * an http(s) page counts, so no internal page is serialized, and the fragment
 * does not matter for which page it is.
 */
export async function tabPageHtml<Entry>(tabs: TabWindow<Entry>, window: Entry, url: unknown): Promise<{ html: string; url: string } | null> {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null
  const wanted = url.replace(/#.*$/, "")
  const tab = tabs.getAll(window).find((candidate) => candidate.url.replace(/#.*$/, "") === wanted && !candidate.loadError)
  if (!tab) return null
  const contents = tabs.tabContents(window, tab.id)
  if (contents.isLoading()) return null
  const html: unknown = await contents.executeJavaScript("document.documentElement.outerHTML", true)
  if (typeof html !== "string" || !html || html.length > MAX_PAGE_HTML) return null
  return { html, url: contents.getURL() }
}
