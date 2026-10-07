import { Capacitor } from "@capacitor/core"
import { createNativeFetch, hasNullBody } from "./nativeFetch"

const connectionFetch = createNativeFetch({
  disableRedirects: true,
  connectTimeout: 120_000,
  readTimeout: 120_000
}, { remoteOnly: true })

/** Add-on connections: no redirects, no cookies, bounded time and size. */
export const mobileAddonFetch: typeof fetch = async (input, init) => {
  if (!Capacitor.isNativePlatform()) return window.fetch(input, init)
  // The native HTTP plugin has no cancellation API. Stop revokes the invocation;
  // the bounded native request may finish, but its result cannot reach the addon.
  const response = await connectionFetch(input, { ...init, credentials: "omit" })
  if (response.status >= 300 && response.status < 400) throw new Error("Connection redirects are not allowed")
  const text = await response.text()
  if (new TextEncoder().encode(text).length > 1024 * 1024) throw new Error("Response is too large")
  return new Response(hasNullBody(response.status) ? null : text, { status: response.status, headers: response.headers })
}
