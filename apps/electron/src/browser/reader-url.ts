// Pure helpers around the once-reader:// scheme, shared by the main process
// (protocol handler, tab manager) and the renderer shell.
//
// A stored document is served at `once-reader://<token>/<source URL>`. The
// token, random and minted when the document is stored, is the URL's host, so
// every document is an origin of its own, and nothing that does not know the
// token can load it. The readable form, `once-reader://<source URL>`, is what
// the address bar shows and accepts: it names the source and is never served.

const READER_TOKEN = /^[a-f0-9]{32}$/

export function isReadableUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://")
}

export function readerErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `Reader mode failed: ${detail}`
}

export function displayBrowserUrl(url: string): string {
  const source = sourceUrlFromReaderUrl(url)
  return source ? `once-reader://${source}` : url
}

/**
 * Tab title for a page that has not set one: the URL stripped down to what
 * identifies it (no scheme, no "www.", no trailing slash). A reader view
 * names its source page. Anything that is not a web page keeps "New tab".
 */
export function fallbackTabTitle(url: string): string {
  const source = sourceUrlFromReaderUrl(url) ?? url
  if (!isReadableUrl(source)) return "New tab"
  try {
    const parsed = new URL(source)
    const host = parsed.host.replace(/^www\./, "")
    const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`.replace(/\/$/, "")
    return `${host}${rest}` || "New tab"
  } catch {
    return "New tab"
  }
}

/** The served form's token, or null for the readable form and anything else. */
export function readerTokenFromUrl(readerUrl: string): string | null {
  if (!readerUrl.startsWith("once-reader://")) return null
  try {
    const host = new URL(readerUrl).hostname
    return READER_TOKEN.test(host) ? host : null
  } catch {
    return null
  }
}

export function sourceUrlFromReaderUrl(readerUrl: string): string | null {
  if (!readerUrl.startsWith("once-reader://")) return null
  try {
    const parsed = new URL(readerUrl)
    // The readable form parses with the source's scheme as its host (and
    // Chromium drops the colon after it once such a URL has navigated).
    if (parsed.hostname === "http" || parsed.hostname === "https") {
      return new URL(`${parsed.hostname}:${parsed.pathname}${parsed.search}${parsed.hash}`).toString()
    }
    if (!READER_TOKEN.test(parsed.hostname)) return null
    const source = new URL(`${parsed.pathname.slice(1)}${parsed.search}${parsed.hash}`)
    if (source.protocol !== "http:" && source.protocol !== "https:") return null
    return source.toString()
  } catch {
    return null
  }
}
