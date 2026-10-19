// `browser.cookies` over Java. Reads come from `Network.getCookies` on the
// browser target (every cookie, with the attributes WebExtensions report);
// writes go through `android.webkit.CookieManager.setCookie`, removal through
// `Network.deleteCookies`. Java watches the jar by polling `Network.getCookies`
// after each write it makes and after `Network.responseReceivedExtraInfo`
// carries a `set-cookie`, and reports differences as `cookies.changed`.

import { CookieChange, CookieQuery, CookieSetDetails, CookieStore, WebExtCookie } from "@once/webext-runtime"
import { JavaChannel } from "./javaChannel"
import { CookieChangedParams } from "./protocol"

/** A `Network.Cookie` as DevTools describes one, in WebExtension shape. */
export function webExtCookie(raw: Record<string, unknown>): WebExtCookie {
  const domain = typeof raw.domain === "string" ? raw.domain : ""
  const expires = typeof raw.expires === "number" ? raw.expires : -1
  const sameSite = raw.sameSite === "Strict" || raw.sameSite === "strict" ? "strict"
    : raw.sameSite === "Lax" || raw.sameSite === "lax" ? "lax" : "no_restriction"
  const cookie: WebExtCookie = {
    name: typeof raw.name === "string" ? raw.name : "",
    value: typeof raw.value === "string" ? raw.value : "",
    domain,
    hostOnly: typeof raw.hostOnly === "boolean" ? raw.hostOnly : !domain.startsWith("."),
    path: typeof raw.path === "string" ? raw.path : "/",
    secure: raw.secure === true,
    httpOnly: raw.httpOnly === true,
    sameSite,
    session: raw.session === true || expires < 0,
    storeId: "0",
    firstPartyDomain: ""
  }
  if (expires >= 0) cookie.expirationDate = expires
  return cookie
}

function changeCause(cause: string): CookieChange["cause"] {
  return cause === "explicit" ? "explicit" : cause === "overwrite" ? "overwrite"
    : cause === "expired" ? "expired" : "evicted"
}

export function liteCookieStore(channel: JavaChannel): CookieStore {
  const listeners = new Set<(change: CookieChange) => void>()
  channel.onEvent("cookies.changed", (params) => {
    const { removed, cookie, cause } = params as CookieChangedParams
    const change: CookieChange = {
      removed: removed === true,
      cookie: webExtCookie((cookie ?? {}) as Record<string, unknown>),
      cause: changeCause(cause)
    }
    for (const listener of listeners) listener(change)
  })
  return {
    get: async (query: CookieQuery) => {
      const result = await channel.request<{ cookies: Record<string, unknown>[] }>("cookies.get", query)
      return (result.cookies ?? []).map(webExtCookie)
    },
    set: async (details: CookieSetDetails) => {
      await channel.request("cookies.set", details)
    },
    remove: async (url: string, name: string) => {
      await channel.request("cookies.remove", { url, name })
    },
    onChanged: (listener) => {
      listeners.add(listener)
    }
  }
}
