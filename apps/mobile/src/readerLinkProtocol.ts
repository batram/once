/**
 * Link taps inside the sandboxed reader frame. The frame is a srcdoc document
 * whose base URL is the app's own page, so letting a tap navigate would load
 * either the app (a bare `#id` resolves against index.html) or a site the app
 * CSP refuses to frame. The frame scrolls to in-page targets itself and hands
 * every other link to the host, which opens it in the browser surface.
 */
export const READER_LINK_CHANNEL = "once-reader-link"
export const READER_LINK_VERSION = 1

export interface ReaderLinkRequest {
  channel: typeof READER_LINK_CHANNEL
  version: typeof READER_LINK_VERSION
  type: "open"
  url: string
}

export type ReaderLinkAction =
  | { kind: "fragment"; id: string }
  | { kind: "open"; url: string }
  | { kind: "retry"; url: string }
  | { kind: "ignore" }

const OPENABLE_PROTOCOLS = ["http:", "https:", "mailto:"]
// "Try again" on the reader's error page links to the reader address of its own page.
const READER_ADDRESS = "once-reader://"

/**
 * What a tap on an anchor with this raw href attribute should do. The reader
 * sanitizer already made every href absolute except same-article fragments.
 */
export function classifyReaderLink(href: string | null): ReaderLinkAction {
  const value = href?.trim() ?? ""
  if (!value) return { kind: "ignore" }
  if (value.startsWith("#")) {
    let id = value.slice(1)
    try { id = decodeURIComponent(id) } catch { /* keep the raw fragment */ }
    return { kind: "fragment", id }
  }
  if (value.startsWith(READER_ADDRESS)) {
    const url = webUrl(value.slice(READER_ADDRESS.length))
    return url ? { kind: "retry", url } : { kind: "ignore" }
  }
  try {
    const url = new URL(value)
    return OPENABLE_PROTOCOLS.includes(url.protocol)
      ? { kind: "open", url: url.href }
      : { kind: "ignore" }
  } catch {
    return { kind: "ignore" }
  }
}

function webUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null
  } catch {
    return null
  }
}

/** The error page asking for its page to be read afresh, in the tab that shows it. */
export interface ReaderRetryRequest {
  channel: typeof READER_LINK_CHANNEL
  version: typeof READER_LINK_VERSION
  type: "retry"
  url: string
}

export function readerRetryRequest(url: string): ReaderRetryRequest {
  return { channel: READER_LINK_CHANNEL, version: READER_LINK_VERSION, type: "retry", url }
}

export function isReaderRetryRequest(value: unknown): value is ReaderRetryRequest {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<ReaderRetryRequest>
  return candidate.channel === READER_LINK_CHANNEL &&
    candidate.version === READER_LINK_VERSION &&
    candidate.type === "retry" &&
    typeof candidate.url === "string"
}

/** Whether a retry for `url` is for the page a tab is reading at `currentUrl`. */
export function retriesPage(url: string, currentUrl: string): boolean {
  const current = webUrl(currentUrl)
  return current !== null && current === webUrl(url)
}

/**
 * A long-press on a link or image. Android's WebView fires contextmenu but
 * draws no menu of its own, so the host asks the native side for one.
 */
export interface ReaderMenuRequest {
  channel: typeof READER_LINK_CHANNEL
  version: typeof READER_LINK_VERSION
  type: "menu"
  link?: string
  linkText?: string
  image?: string
}

export function isReaderMenuRequest(value: unknown): value is ReaderMenuRequest {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<ReaderMenuRequest>
  return candidate.channel === READER_LINK_CHANNEL &&
    candidate.version === READER_LINK_VERSION &&
    candidate.type === "menu"
}

export function readerLinkRequest(url: string): ReaderLinkRequest {
  return { channel: READER_LINK_CHANNEL, version: READER_LINK_VERSION, type: "open", url }
}

export function isReaderLinkRequest(value: unknown): value is ReaderLinkRequest {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<ReaderLinkRequest>
  return candidate.channel === READER_LINK_CHANNEL &&
    candidate.version === READER_LINK_VERSION &&
    candidate.type === "open" &&
    typeof candidate.url === "string"
}
