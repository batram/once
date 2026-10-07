import { Capacitor, CapacitorHttp } from "@capacitor/core"
import type { HttpOptions } from "@capacitor/core"

// Captured before installNativeFetch replaces the global, so same-origin
// requests reach the web view's own fetch rather than this module again.
const webFetch = window.fetch.bind(window)

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

export function hasNullBody(status: number): boolean {
  return NULL_BODY_STATUSES.has(status)
}

/**
 * A fetch whose cross-origin http(s) requests go through the native HTTP
 * plugin, so feeds, sync and searches are not held to CORS on the native
 * platforms. Same-origin and non-http(s) requests stay with the web view.
 *
 * It replaces Capacitor's fetch patch, which capacitor.config.ts turns off:
 * that patch sent GETs through a same-origin proxy path that the web view
 * also serves to <script>, workers and service workers, which turns
 * `script-src 'self'` into any script on the web. This only ever hands a
 * Response to its caller.
 *
 * Bodies and responses travel as text, which is all the mobile callers read;
 * binary payloads would not arrive byte-exact. `options` are passed to every
 * native request (redirects, timeouts). With `remoteOnly`, a request for the
 * app's own origin or a non-http(s) URL is refused instead of handed to the
 * web view, which would serve app files and `_capacitor_file_` paths.
 */
export function createNativeFetch(
  options: Partial<HttpOptions> = {},
  { remoteOnly = false } = {}
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    if (!Capacitor.isNativePlatform()) return webFetch(input, init)
    if (!isCrossOriginHttp(request.url)) {
      if (remoteOnly) throw new TypeError(`Only remote http(s) URLs can be fetched: ${request.url}`)
      return webFetch(input, init)
    }
    request.signal.throwIfAborted()
    const headers = Object.fromEntries(request.headers)
    // A cross-origin fetch carries cookies only with credentials: "include".
    if (request.credentials !== "include") headers.Cookie = ""
    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text()
    const native = await CapacitorHttp.request({
      ...options,
      url: request.url,
      method: request.method,
      headers,
      data: body || undefined,
      responseType: "text"
    })
    // The plugin has no cancellation API: an aborted request may still
    // finish natively, but its result does not reach the caller.
    request.signal.throwIfAborted()
    // The plugin parses JSON responses itself; give callers the text back.
    const text = native.data == null || typeof native.data === "string"
      ? native.data
      : JSON.stringify(native.data)
    const response = new Response(hasNullBody(native.status) ? null : text, {
      status: native.status,
      headers: native.headers
    })
    Object.defineProperty(response, "url", { value: native.url || request.url })
    return response
  }
}

export const nativeFetch = createNativeFetch()

/**
 * Points the global fetch at nativeFetch on the native platforms, for code
 * that has no fetch seam of its own, such as the collectors' searches.
 */
export function installNativeFetch(): void {
  if (Capacitor.isNativePlatform()) window.fetch = nativeFetch
}

function isCrossOriginHttp(url: string): boolean {
  const parsed = new URL(url)
  return (parsed.protocol === "https:" || parsed.protocol === "http:")
    && parsed.origin !== window.location.origin
}
