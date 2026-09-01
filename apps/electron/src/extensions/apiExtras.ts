// Namespaces beyond the core set: cookies over the browser session,
// dynamic content scripts, and the inert notifications and commands that
// extensions probe for and can live without.

import { ApiHandler } from "./ExtensionApi"
import { registeredContentScript } from "./contentScripts"

type Handlers = Record<string, ApiHandler>

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

/** Electron's cookie shape, as `browser.cookies` describes one. */
function webExtCookie(cookie: Electron.Cookie): Record<string, unknown> {
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

function cookieFilter(details: Record<string, unknown>): Electron.CookiesGetFilter {
  const filter: Electron.CookiesGetFilter = {}
  const url = optionalString(details.url)
  const name = optionalString(details.name)
  const domain = optionalString(details.domain)
  const path = optionalString(details.path)
  const secure = optionalBoolean(details.secure)
  const session = optionalBoolean(details.session)
  if (url !== undefined) filter.url = url
  if (name !== undefined) filter.name = name
  if (domain !== undefined) filter.domain = domain
  if (path !== undefined) filter.path = path
  if (secure !== undefined) filter.secure = secure
  if (session !== undefined) filter.session = session
  return filter
}

export function cookieHandlers(): Handlers {
  return {
    "cookies.get": async ({ host }, details) => {
      const record = asRecord(details)
      const [cookie] = await host.cookies.get(cookieFilter(record))
      return cookie ? webExtCookie(cookie) : null
    },
    "cookies.getAll": async ({ host }, details) =>
      (await host.cookies.get(cookieFilter(asRecord(details)))).map(webExtCookie),
    "cookies.set": async ({ host }, details) => {
      const record = asRecord(details)
      const url = optionalString(record.url)
      if (!url) throw new Error("cookies.set needs a url")
      const cookie: Electron.CookiesSetDetails = { url }
      const name = optionalString(record.name)
      const value = optionalString(record.value)
      const domain = optionalString(record.domain)
      const path = optionalString(record.path)
      const secure = optionalBoolean(record.secure)
      const httpOnly = optionalBoolean(record.httpOnly)
      if (name !== undefined) cookie.name = name
      if (value !== undefined) cookie.value = value
      if (domain !== undefined) cookie.domain = domain
      if (path !== undefined) cookie.path = path
      if (secure !== undefined) cookie.secure = secure
      if (httpOnly !== undefined) cookie.httpOnly = httpOnly
      if (typeof record.expirationDate === "number") cookie.expirationDate = record.expirationDate
      if (record.sameSite === "strict" || record.sameSite === "lax") cookie.sameSite = record.sameSite
      else if (record.sameSite === "no_restriction") cookie.sameSite = "no_restriction"
      await host.cookies.set(cookie)
      const [stored] = await host.cookies.get({ url, name: cookie.name })
      return stored ? webExtCookie(stored) : null
    },
    "cookies.remove": async ({ host }, details) => {
      const record = asRecord(details)
      const url = optionalString(record.url)
      const name = optionalString(record.name)
      if (!url || name === undefined) throw new Error("cookies.remove needs url and name")
      await host.cookies.remove(url, name)
      return { url, name, storeId: "0", firstPartyDomain: "" }
    },
    "cookies.getAllCookieStores": ({ host }) => [
      { id: "0", tabIds: host.hooks.tabs().map((tab) => tab.id), incognito: false }
    ]
  }
}

/** `contentScripts.register`: the script joins the frames that match from now on. */
export function contentScriptHandlers(): Handlers {
  return {
    "contentScripts.register": ({ host }, options) =>
      host.registerContentScript(registeredContentScript(options)),
    "contentScripts.unregister": ({ host }, id) => {
      if (typeof id === "number") host.registeredScripts.delete(id)
    }
  }
}

/** Manifest permissions are all there is; optional ones are never granted. */
export function permissionHandlers(): Handlers {
  const granted = (host: { extension: { manifest: { permissions: ReadonlySet<string>; hostPermissions: readonly string[] } } }) => ({
    permissions: [...host.extension.manifest.permissions],
    origins: [...host.extension.manifest.hostPermissions]
  })
  return {
    "permissions.getAll": ({ host }) => granted(host),
    "permissions.contains": ({ host }, request) => {
      const record = asRecord(request)
      const have = granted(host)
      const wanted = Array.isArray(record.permissions) ? record.permissions : []
      const origins = Array.isArray(record.origins) ? record.origins : []
      return wanted.every((name) => have.permissions.includes(name)) &&
        origins.every((origin) => have.origins.includes(origin))
    },
    "permissions.request": () => false,
    "permissions.remove": () => false,
    "extension.isAllowedFileSchemeAccess": () => false
  }
}

/** APIs an extension may call without anything happening on screen. */
export function inertHandlers(): Handlers {
  let nextNotification = 1
  return {
    "notifications.create": (_call, first) =>
      typeof first === "string" && first.length > 0 ? first : `notification-${nextNotification++}`,
    "notifications.clear": () => true,
    "notifications.getAll": () => ({}),
    "notifications.update": () => false,
    "commands.getAll": () => []
  }
}
