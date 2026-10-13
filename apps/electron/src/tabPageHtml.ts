import type { WebContents } from "electron"

interface TabLike { id: string; url: string; loadError: string | null }
interface TabWindow<Entry> {
  getAll(window: Entry): TabLike[]
  tabContents(window: Entry, id: string): WebContents
}

/** Anything larger is not an article; a tab's DOM can be a whole application. */
const MAX_PAGE_HTML = 8 * 1024 * 1024
/**
 * How long a read waits for a tab still loading the page. A page is often
 * asked about the moment it is opened ("Open article", then restart the
 * conversation): without the wait that read fetched the page instead of
 * using the tab the reader had just opened for it.
 */
const LOAD_WAIT_MS = 5_000

/**
 * The page as the tab shows it, after its scripts ran: what a reader would
 * see where a fetch finds only what the server sent. Only a finished load of
 * an http(s) page counts, so no internal page is serialized, and the fragment
 * does not matter for which page it is.
 */
export async function tabPageHtml<Entry>(tabs: TabWindow<Entry>, window: Entry, url: unknown): Promise<{ html: string; url: string } | null> {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null
  const wanted = url.replace(/#.*$/, "")
  const showing = (id?: string) => tabs.getAll(window).find((candidate) =>
    (id === undefined || candidate.id === id) && candidate.url.replace(/#.*$/, "") === wanted && !candidate.loadError)
  const tab = showing()
  if (!tab) return null
  const contents = tabs.tabContents(window, tab.id)
  if (contents.isLoading()) {
    // The tab may move on, fail or close while it loads: it must still show the page after.
    if (!await loaded(contents, LOAD_WAIT_MS) || !showing(tab.id)) return null
  }
  const html: unknown = await contents.executeJavaScript("document.contentType === 'application/pdf' ? null : document.documentElement.outerHTML", true)
  if (typeof html !== "string" || !html || html.length > MAX_PAGE_HTML) return null
  return { html, url: contents.getURL() }
}

/** Resolves true once the tab stops loading, false when it closes or the wait runs out first. */
function loaded(contents: WebContents, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer)
      contents.removeListener("did-stop-loading", stopped)
      contents.removeListener("destroyed", closed)
      resolve(value)
    }
    // A redirect or a script's reload starts another load; the read waits for that too.
    const stopped = () => { if (!contents.isLoading()) finish(true) }
    const closed = () => finish(false)
    const timer = setTimeout(() => finish(false), timeout)
    contents.on("did-stop-loading", stopped)
    contents.once("destroyed", closed)
  })
}
