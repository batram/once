// Namespaces beyond the core set: cookies over the host's cookie store,
// dynamic content scripts, and the inert notifications and commands that
// extensions probe for and can live without.

import { ApiHandler, ApiHost } from "./ExtensionApi"
import { registeredContentScript } from "./contentScripts"
import { CookieChange, CookieQuery, CookieSetDetails, WebExtCookie } from "./hostServices"
import { canAccessCookie, requireHost, requireHostPattern, requirePermission } from "./extensionPermissions"

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

function cookieFilter(details: Record<string, unknown>): CookieQuery {
  const filter: CookieQuery = {}
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
  const allowed = (host: ApiHost, cookie: WebExtCookie): boolean => canAccessCookie(host.extension, cookie)
  return {
    "cookies.get": async ({ host }, details) => {
      requirePermission(host.extension, "cookies")
      const record = asRecord(details)
      if (typeof record.url !== "string") throw new Error("cookies.get needs a url")
      requireHost(host.extension, record.url)
      const [cookie] = await host.cookies.get(cookieFilter(record))
      return cookie && allowed(host, cookie) ? cookie : null
    },
    "cookies.getAll": async ({ host }, details) => {
      requirePermission(host.extension, "cookies")
      const record = asRecord(details)
      if (typeof record.url === "string") requireHost(host.extension, record.url)
      return (await host.cookies.get(cookieFilter(record))).filter((cookie) => allowed(host, cookie))
    },
    "cookies.set": async ({ host }, details) => {
      requirePermission(host.extension, "cookies")
      const record = asRecord(details)
      const url = optionalString(record.url)
      if (!url) throw new Error("cookies.set needs a url")
      requireHost(host.extension, url)
      const cookie: CookieSetDetails = { url }
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
      return stored ?? null
    },
    "cookies.remove": async ({ host }, details) => {
      requirePermission(host.extension, "cookies")
      const record = asRecord(details)
      const url = optionalString(record.url)
      const name = optionalString(record.name)
      if (!url || name === undefined) throw new Error("cookies.remove needs url and name")
      requireHost(host.extension, url)
      await host.cookies.remove(url, name)
      return { url, name, storeId: "0", firstPartyDomain: "" }
    },
    "cookies.getAllCookieStores": ({ host }) => {
      requirePermission(host.extension, "cookies")
      return [
        { id: "0", tabIds: host.hooks.tabs().map((tab) => tab.id), incognito: false }
      ]
    }
  }
}

/** `contentScripts.register`: the script joins the frames that match from now on. */
export function contentScriptHandlers(): Handlers {
  return {
    "contentScripts.register": ({ host }, options) => {
      const script = registeredContentScript(options)
      for (const pattern of script.spec.matches) requireHostPattern(host.extension, pattern)
      return host.registerContentScript(script)
    },
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

/** A cookie changed in the browser session: every extension allowed to see it hears. */
export function broadcastCookieChange(hosts: Iterable<ApiHost>, change: CookieChange): void {
  for (const host of hosts) {
    if (!host.extension.manifest.permissions.has("cookies")) continue
    if (!canAccessCookie(host.extension, change.cookie)) continue
    host.contexts.emit("cookies", "onChanged", [change])
  }
}
