/** Anything larger is not an article; a page's DOM can be a whole application. */
const MAX_LIVE_PAGE_HTML = 8 * 1024 * 1024

/**
 * Evaluated in a page a shell has open: `{ html, url }`, its document as it
 * stands after its scripts ran and the address it is at, or null. Only a real
 * page answers. An image, a text file or a PDF viewer is a wrapper the engine
 * built around bytes the reader reads better itself (text recognition, PDF
 * extraction), and taking that markup for the article would hide them from it.
 */
export const LIVE_PAGE_SCRIPT = `(() => {
  if (!/^(text\\/html|application\\/xhtml\\+xml)$/.test(document.contentType)) return null
  const html = document.documentElement.outerHTML
  return html.length > ${MAX_LIVE_PAGE_HTML} ? null : { html, url: location.href }
})()`

/**
 * What `LIVE_PAGE_SCRIPT` answered, as the value itself (Electron) or as the
 * JSON a mobile surface's bridge carries it in; null for anything else.
 */
export function readLivePage(answer: unknown): { html: string; url: string } | null {
  let page = answer
  if (typeof answer === "string") {
    try { page = JSON.parse(answer) } catch { return null }
  }
  if (!page || typeof page !== "object") return null
  const { html, url } = page as { html?: unknown; url?: unknown }
  if (typeof html !== "string" || !html || html.length > MAX_LIVE_PAGE_HTML || typeof url !== "string") return null
  return { html, url }
}

/** Whether two addresses name the same document: a fragment only says where in it. */
export function sameDocumentUrl(a: string, b: string): boolean {
  return a.replace(/#.*$/, "") === b.replace(/#.*$/, "")
}
