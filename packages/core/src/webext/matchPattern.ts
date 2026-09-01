// WebExtension match patterns, as Firefox defines them:
// https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/Match_patterns
//
// A pattern is `<scheme>://<host><path>` or the special `<all_urls>`. The
// scheme `*` means http or https only; the host is exact, `*`, or `*.` plus
// a domain, which also matches the bare domain; the path is a glob where `*`
// matches anything and is tested against the URL's path plus query. Ports and
// fragments never take part in matching.

export const ALL_URLS = "<all_urls>"

const ALL_URL_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp", "ftps", "data", "file"])
const WILDCARD_SCHEMES = new Set(["http", "https"])
const PATTERN_SCHEMES = new Set([...ALL_URL_SCHEMES, "*"])

export interface MatchPattern {
  readonly source: string
  readonly allUrls: boolean
  readonly schemes: ReadonlySet<string>
  /** Lower-case host, `*` for any, or a domain; `subdomains` widens it. */
  readonly host: string
  readonly subdomains: boolean
  readonly path: RegExp
}

export class MatchPatternError extends Error {
  constructor(pattern: string, reason: string) {
    super(`Invalid match pattern "${pattern}": ${reason}`)
    this.name = "MatchPatternError"
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`)
}

export function parseMatchPattern(source: string): MatchPattern {
  if (source === ALL_URLS) {
    return {
      source,
      allUrls: true,
      schemes: ALL_URL_SCHEMES,
      host: "*",
      subdomains: false,
      path: /^.*$/
    }
  }

  const separator = source.indexOf("://")
  if (separator < 0) throw new MatchPatternError(source, "missing scheme separator")
  const scheme = source.slice(0, separator)
  if (!PATTERN_SCHEMES.has(scheme)) {
    throw new MatchPatternError(source, `unsupported scheme "${scheme}"`)
  }

  const rest = source.slice(separator + 3)
  const slash = rest.indexOf("/")
  if (slash < 0) throw new MatchPatternError(source, "path must start with /")
  const hostPart = rest.slice(0, slash).toLowerCase()
  const pathPart = rest.slice(slash)

  let host = hostPart
  let subdomains = false
  if (scheme === "file") {
    // Firefox accepts both `file:///*` and `file://*/*`; uBlock ships the latter.
    if (hostPart !== "" && hostPart !== "*") {
      throw new MatchPatternError(source, "file patterns have no host")
    }
    host = "*"
  } else if (hostPart === "") {
    throw new MatchPatternError(source, "missing host")
  } else if (hostPart === "*") {
    host = "*"
  } else if (hostPart.startsWith("*.")) {
    host = hostPart.slice(2)
    subdomains = true
  }
  if (host !== "*" && (host.includes("*") || host.includes(":"))) {
    throw new MatchPatternError(source, "host may only start with *. and has no port")
  }

  return {
    source,
    allUrls: false,
    schemes: scheme === "*" ? WILDCARD_SCHEMES : new Set([scheme]),
    host,
    subdomains,
    path: globToRegExp(pathPart)
  }
}

export function isMatchPattern(source: string): boolean {
  try {
    parseMatchPattern(source)
    return true
  } catch {
    return false
  }
}

function hostMatches(pattern: MatchPattern, hostname: string): boolean {
  if (pattern.host === "*") return true
  if (hostname === pattern.host) return true
  return pattern.subdomains && hostname.endsWith(`.${pattern.host}`)
}

export function matchPatternMatches(pattern: MatchPattern, url: URL): boolean {
  const scheme = url.protocol.slice(0, -1)
  if (!pattern.schemes.has(scheme)) return false
  if (pattern.allUrls) return true
  if (scheme !== "file" && !hostMatches(pattern, url.hostname.toLowerCase())) return false
  return pattern.path.test(`${url.pathname}${url.search}`)
}

/** A compiled set of patterns answering one question: does this URL match any? */
export class MatchPatternSet {
  private readonly patterns: MatchPattern[]

  constructor(sources: readonly string[]) {
    this.patterns = sources.map(parseMatchPattern)
  }

  get size(): number {
    return this.patterns.length
  }

  matches(url: URL | string): boolean {
    const parsed = typeof url === "string" ? tryUrl(url) : url
    if (!parsed) return false
    return this.patterns.some((pattern) => matchPatternMatches(pattern, parsed))
  }
}

export function tryUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}
