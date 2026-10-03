import { MatchPattern, MatchPatternSet, parseMatchPattern } from "@once/core"
import type { LoadedExtension } from "./LoadedExtension"

export function requirePermission(extension: LoadedExtension, name: string): void {
  if (!extension.manifest.permissions.has(name)) throw new Error(`Missing ${name} permission`)
}

// Host grants cover origins, regardless of the path used in a match pattern.
const hostGrants = new WeakMap<LoadedExtension, { set: MatchPatternSet; patterns: MatchPattern[] }>()
function grants(extension: LoadedExtension): { set: MatchPatternSet; patterns: MatchPattern[] } {
  let cached = hostGrants.get(extension)
  if (cached) return cached
  const sources = extension.manifest.hostPermissions.map((source) => {
    if (source === "<all_urls>") return source
    return `${source.slice(0, source.indexOf("/", source.indexOf("://") + 3))}/*`
  })
  cached = { set: new MatchPatternSet(sources), patterns: sources.map((source) => parseMatchPattern(source)) }
  hostGrants.set(extension, cached)
  return cached
}

export function permittedHosts(extension: LoadedExtension): MatchPatternSet {
  return grants(extension).set
}

export function requireHost(extension: LoadedExtension, url: string): void {
  if (!permittedHosts(extension).matches(url)) throw new Error(`Missing host permission for ${url}`)
}

export function canAccessCookie(
  extension: LoadedExtension,
  cookie: Pick<Electron.Cookie, "domain" | "hostOnly" | "secure">
): boolean {
  const domain = (cookie.domain ?? "").replace(/^\./, "").toLowerCase()
  if (!domain) return false
  const { set: permitted, patterns } = grants(extension)
  const schemes = cookie.secure ? ["https"] : ["https", "http"]
  if (cookie.hostOnly) return schemes.some((scheme) => permitted.matches(`${scheme}://${domain}/`))
  return patterns.some((pattern) => {
    // A wildcard grant covers the cookie's own domain when it sits beneath it.
    const covers = pattern.host === "*" || (pattern.subdomains && domain.endsWith(`.${pattern.host}`))
    const host = covers ? domain : pattern.host
    if (host !== domain && !host.endsWith(`.${domain}`)) return false
    return schemes.some((scheme) => permitted.matches(`${scheme}://${host}/`))
  })
}

/** A dynamic script's entire requested origin range must be granted. */
export function requireHostPattern(extension: LoadedExtension, source: string): void {
  const requested = parseMatchPattern(source)
  const granted = extension.manifest.hostPermissions.some((entry) => {
    const permission = parseMatchPattern(entry)
    if ([...requested.schemes].some((scheme) => !permission.schemes.has(scheme))) return false
    if (permission.host === "*") return true
    if (requested.host === "*") return false
    if (requested.host === permission.host) return !requested.subdomains || permission.subdomains
    return permission.subdomains && requested.host.endsWith(`.${permission.host}`)
  })
  if (!granted) throw new Error(`Missing host permission for ${source}`)
}
