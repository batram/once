/**
 * The "site" a page belongs to, as far as clearing browsing data goes: the
 * registrable domain (eTLD+1), so news.example.co.uk and login.example.co.uk
 * are both example.co.uk. Cookies are usually set on that parent domain, which
 * is why clearing only the exact host would not log anyone out.
 *
 * Every engine Once drives agrees on this unit: GeckoView clears by base domain
 * and WebKit groups its data records by it. Hosts without a public suffix
 * (localhost, IP addresses) are their own site.
 */

import { parse } from "tldts"

export function siteForUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!host) return null
  const info = parse(host)
  if (info.isIp) return host
  return info.domain ?? host
}

/** True when `host` is `site` itself or one of its subdomains. */
export function hostBelongsToSite(host: string, site: string): boolean {
  const bare = host.replace(/^\./, "").toLowerCase()
  return bare === site || bare.endsWith(`.${site}`)
}
