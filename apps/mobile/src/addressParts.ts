/**
 * Plain-text operations behind the address editor's quick edits. The editor
 * keeps one text field; "exploded" only inserts line breaks between the
 * parts of the address, so joining the lines always gives the address back.
 */

const TRACKING_PARAMETER = /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|ref_url|si|_hsenc|_hsmi|yclid)$/i
const ADDRESS_PARTS = /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i

export interface AddressParts {
  scheme: string
  host: string
  path: string
  query: string
  hash: string
}

export function splitAddress(text: string): AddressParts {
  const match = ADDRESS_PARTS.exec(text)
  if (!match) return { scheme: "", host: "", path: text, query: "", hash: "" }
  return { scheme: match[1] ?? "", host: match[2] ?? "", path: match[3] ?? "", query: match[4] ?? "", hash: match[5] ?? "" }
}

export function isTrackingParameter(name: string): boolean {
  return TRACKING_PARAMETER.test(name)
}

export function joinAddress(text: string): string {
  return text.replace(/[\r\n]+/g, "")
}

/** One line per part: site, each path segment, each query parameter, fragment. */
export function explodeAddress(text: string): string {
  const parts = splitAddress(text)
  const lines = [parts.scheme + parts.host]
  const segments = parts.path.match(/\/[^/]*/g) ?? []
  // A trailing slash stays on its segment instead of taking a line of its own.
  if (segments.length > 1 && segments.at(-1) === "/") {
    segments.pop()
    segments[segments.length - 1] += "/"
  }
  if (segments.length === 1 && segments[0] === "/") lines[0] += "/"
  else lines.push(...segments)
  if (parts.query) parts.query.split("&").forEach((part, index) => lines.push(index ? `&${part}` : part))
  if (parts.hash) lines.push(parts.hash)
  return lines.filter((line, index) => index === 0 || line !== "").join("\n")
}

/** The caret's offset in the joined address, given its offset in `display`. */
export function joinedOffset(display: string, offset: number): number {
  return offset - (display.slice(0, offset).match(/[\r\n]/g) ?? []).length
}

/** The offset in `display` of the joined address's offset `joined`. */
export function displayOffset(display: string, joined: number): number {
  let count = 0
  for (let index = 0; index < display.length; index += 1) {
    if (count === joined) return index
    if (display[index] !== "\n" && display[index] !== "\r") count += 1
  }
  return display.length
}

function webAddress(text: string): URL | null {
  try {
    const url = new URL(text)
    return url.protocol === "http:" || url.protocol === "https:" ? url : null
  } catch {
    return null
  }
}

export function trackingParameters(text: string): string[] {
  const url = webAddress(text)
  if (!url) return []
  const names: string[] = []
  url.searchParams.forEach((_value, name) => {
    if (isTrackingParameter(name) && !names.includes(name)) names.push(name)
  })
  return names
}

export function withoutTrackingParameters(text: string): string {
  const url = webAddress(text)
  if (!url) return text
  for (const name of trackingParameters(text)) url.searchParams.delete(name)
  return url.toString()
}

/**
 * The last part of a web address, the part "Remove" takes off: the query and
 * fragment first, then one path segment at a time. Null at the site root.
 */
export function lastAddressPart(text: string): { label: string; rest: string } | null {
  const url = webAddress(text)
  if (!url) return null
  if (url.search || url.hash) {
    const label = url.search + url.hash
    url.search = ""
    url.hash = ""
    return { label, rest: url.toString() }
  }
  if (url.pathname === "/") return null
  const segments = url.pathname.replace(/\/+$/, "").split("/")
  const label = `/${segments.pop()}`
  url.pathname = `${segments.join("/")}/`
  return { label, rest: url.toString() }
}
