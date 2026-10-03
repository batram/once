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
  | { kind: "ignore" }

const OPENABLE_PROTOCOLS = ["http:", "https:", "mailto:"]

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
  try {
    const url = new URL(value)
    return OPENABLE_PROTOCOLS.includes(url.protocol)
      ? { kind: "open", url: url.href }
      : { kind: "ignore" }
  } catch {
    return { kind: "ignore" }
  }
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
