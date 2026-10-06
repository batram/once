/**
 * What may leave the device. Only http(s) pages are published; credentials in
 * the URL are dropped; tabs on an excluded domain, or any of its subdomains,
 * are not published at all.
 */
export function publishableUrl(value: string, excludedDomains: readonly string[] = []): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  const host = url.hostname.toLowerCase().replace(/\.$/, "")
  if (!host || excludedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return null
  url.username = ""
  url.password = ""
  return url.href
}

/**
 * A user's excluded-domain list, from text or entries: lowercased host names,
 * without schemes, paths, ports or a leading "*." or ".", deduplicated.
 */
export function normalizeExcludedDomains(value: unknown): string[] {
  const entries = typeof value === "string" ? value.split(/[\s,]+/) : Array.isArray(value) ? value : []
  const domains = entries.flatMap((entry) => {
    if (typeof entry !== "string") return []
    let host = entry.trim().toLowerCase()
    if (!host) return []
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
      try { host = new URL(host).hostname } catch { return [] }
    }
    host = host.replace(/^\*?\./, "").replace(/[/:].*$/, "").replace(/\.$/, "")
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host) ? [host] : []
  })
  return [...new Set(domains)]
}
