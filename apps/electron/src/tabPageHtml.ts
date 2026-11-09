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
  const contents = await showingTab(tabs, window, url)
  if (!contents) return null
  const html: unknown = await contents.executeJavaScript("document.contentType === 'application/pdf' ? null : document.documentElement.outerHTML", true)
  if (typeof html !== "string" || !html || html.length > MAX_PAGE_HTML) return null
  return { html, url: contents.getURL() }
}

/** The reader's own cap on a document; a larger PDF is left to the fetch that reports it. */
const MAX_PDF_BYTES = 64 * 1024 * 1024
/**
 * Read as the tab itself: a site behind a bot challenge (Cloudflare's "Just a
 * moment...") lets the tab through once it has solved the challenge and
 * answers anyone else with 403. The clearance cookie is partitioned to the
 * site and tied to the tab's user agent, so only a request from the tab
 * carries it. Its HTTP cache comes first and makes no request at all; it misses
 * when the challenge delivered the PDF as the answer to its POST, and then
 * the tab asks again.
 */
const TAB_PDF_SCRIPT = `(async () => {
  if (document.contentType !== "application/pdf") return null
  const read = async (cache) => {
    try {
      const response = await fetch(location.href, { cache, mode: "same-origin", credentials: "include" })
      if (!response.ok) return null
      if (Number(response.headers.get("content-length") || 0) > ${MAX_PDF_BYTES}) return null
      const bytes = new Uint8Array(await response.arrayBuffer())
      return String.fromCharCode(...bytes.subarray(0, 1024)).includes("%PDF-") ? bytes : null
    } catch { return null }
  }
  return await read("only-if-cached") ?? await read("no-cache")
})()`

/**
 * The bytes of a PDF an open tab shows, read as that tab, or null when no
 * finished tab shows `url` as a PDF or the tab cannot get it either.
 */
export async function tabPdfBytes<Entry>(tabs: TabWindow<Entry>, window: Entry, url: unknown): Promise<{ bytes: Uint8Array; url: string } | null> {
  const contents = await showingTab(tabs, window, url)
  if (!contents) return null
  const result: unknown = await contents.executeJavaScript(TAB_PDF_SCRIPT, true)
  const bytes = result instanceof Uint8Array ? result : result instanceof ArrayBuffer ? new Uint8Array(result) : null
  // A cached error or challenge page is not the document; the signature says which it is.
  if (!bytes || bytes.byteLength > MAX_PDF_BYTES || !isPdf(bytes)) return null
  return { bytes, url: contents.getURL() }
}

function isPdf(bytes: Uint8Array): boolean {
  const head = String.fromCharCode(...bytes.subarray(0, 1024))
  return head.includes("%PDF-")
}

/** The contents of this window's tab showing `url` once it has loaded, or null. */
async function showingTab<Entry>(tabs: TabWindow<Entry>, window: Entry, url: unknown): Promise<WebContents | null> {
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
  return contents
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
