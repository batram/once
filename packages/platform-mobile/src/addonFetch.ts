import { Capacitor, CapacitorHttp } from "@capacitor/core"

/** Capacitor's fetch patch does not forward RequestInit.redirect or AbortSignal. */
export const mobileAddonFetch: typeof fetch = async (input, init) => {
  if (!Capacitor.isNativePlatform()) return window.fetch(input, init)
  const request = new Request(input, init)
  const signal = init?.signal
  signal?.throwIfAborted()
  const response = await CapacitorHttp.request({
    url: request.url, method: request.method,
    headers: { ...Object.fromEntries(request.headers), Cookie: "" },
    data: request.method === "POST" ? await request.text() : undefined,
    responseType: "text", disableRedirects: true,
    connectTimeout: 120_000, readTimeout: 120_000
  })
  // The native HTTP plugin has no cancellation API. Stop revokes the invocation;
  // the bounded native request may finish, but its result cannot reach the addon.
  signal?.throwIfAborted()
  if (response.status >= 300 && response.status < 400) throw new Error("Connection redirects are not allowed")
  const text = typeof response.data === "string" ? response.data : JSON.stringify(response.data)
  if (new TextEncoder().encode(text).length > 1024 * 1024) throw new Error("Response is too large")
  return new Response(response.status === 204 ? null : text, { status: response.status, headers: response.headers })
}
