// The Electron shell shows a page's reader copy under its own `once-reader://`
// scheme, in one of two forms. The readable form, `once-reader://<source URL>`,
// is what its address bar shows and accepts; parsed, the source's scheme
// becomes the host (and Chromium drops the colon after it once such a URL has
// navigated). The served form, `once-reader://<token>/<source URL>`, carries a
// random token as its host, so every copy is an origin of its own, and the
// whole source as its path. Both name the source page.

const READER_TOKEN = /^[a-f0-9]{32}$/

/** The source page a reader URL names, or null for any other URL. */
export function readerSourceUrl(url: string): string | null {
  if (!url.startsWith("once-reader://")) return null
  try {
    const parsed = new URL(url)
    if (parsed.hostname === "http" || parsed.hostname === "https") {
      return new URL(`${parsed.hostname}:${parsed.pathname}${parsed.search}${parsed.hash}`).href
    }
    if (!READER_TOKEN.test(parsed.hostname)) return null
    const source = new URL(`${parsed.pathname.slice(1)}${parsed.search}${parsed.hash}`)
    return source.protocol === "http:" || source.protocol === "https:" ? source.href : null
  } catch {
    return null
  }
}
