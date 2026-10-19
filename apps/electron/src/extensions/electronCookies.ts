// The browser session's cookie jar in the shapes `browser.cookies` uses.

import { CookieChange, CookieStore, WebExtCookie } from "@once/webext-runtime"

/** Electron's cookie shape, as `browser.cookies` describes one. */
export function webExtCookie(cookie: Electron.Cookie): WebExtCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? "",
    hostOnly: cookie.hostOnly ?? false,
    path: cookie.path ?? "/",
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: cookie.sameSite === "strict" ? "strict" : cookie.sameSite === "lax" ? "lax" : "no_restriction",
    session: cookie.session ?? cookie.expirationDate === undefined,
    expirationDate: cookie.expirationDate,
    storeId: "0",
    firstPartyDomain: ""
  }
}

function changeCause(cause: string): CookieChange["cause"] {
  return cause === "explicit" ? "explicit" : cause === "overwrite" ? "overwrite"
    : cause === "expired" || cause === "expired-overwrite" ? "expired" : "evicted"
}

export function electronCookieStore(cookies: Electron.Cookies): CookieStore {
  return {
    get: async (query) => (await cookies.get(query)).map(webExtCookie),
    set: (details) => cookies.set(details),
    remove: (url, name) => cookies.remove(url, name),
    onChanged: (listener) => {
      cookies.on("changed", (_event, cookie, cause, removed) => {
        // The changed cookie travels as Electron reports it plus its store,
        // which is what extensions have been receiving here.
        listener({ removed, cookie: { ...cookie, storeId: "0" } as unknown as WebExtCookie, cause: changeCause(cause) })
      })
    }
  }
}
