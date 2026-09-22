// Pure helpers around the once-reader:// scheme, shared by the main process
// (protocol handler, tab manager) and the renderer shell.

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

export function sourceUrlFromReaderUrl(readerUrl: string): string | null {
  if (!readerUrl.startsWith("once-reader://")) return null
  try {
    const parsed = new URL(readerUrl)
    if (parsed.hostname !== "http" && parsed.hostname !== "https") return null
    return new URL(`${parsed.hostname}:${parsed.pathname}${parsed.search}${parsed.hash}`).toString()
  } catch {
    return null
  }
}
