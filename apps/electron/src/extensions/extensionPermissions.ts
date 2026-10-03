import { MatchPatternSet, parseMatchPattern } from "@once/core"
import type { LoadedExtension } from "./LoadedExtension"

export function requirePermission(extension: LoadedExtension, name: string): void {
  if (!extension.manifest.permissions.has(name)) throw new Error(`Missing ${name} permission`)
}

// Host grants cover origins, regardless of the path used in a match pattern.
export function permittedHosts(extension: LoadedExtension): MatchPatternSet {
  return new MatchPatternSet(extension.manifest.hostPermissions.map((source) => {
    if (source === "<all_urls>") return source
    return `${source.slice(0, source.indexOf("/", source.indexOf("://") + 3))}/*`
  }))
}

export function requireHost(extension: LoadedExtension, url: string): void {
  if (!permittedHosts(extension).matches(url)) throw new Error(`Missing host permission for ${url}`)
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
