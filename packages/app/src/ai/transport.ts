import { AiError, AiConnection, SearchConnection, AddonResponse } from "@once/core"

export async function aiTransport(fetch: typeof globalThis.fetch, connection: AiConnection | SearchConnection,
  token: string, request: { method?: string; body?: string; headers?: Record<string, string>; query?: Record<string, string> },
  signal?: AbortSignal, onChunk?: (text: string) => void): Promise<AddonResponse> {
  signal?.throwIfAborted()
  const headers = new Headers(request.headers)
  headers.set("accept", "application/json")
  if (token) headers.set(connection.provider === "anthropic" ? "x-api-key" : "authorization", connection.provider === "anthropic" ? token : `Bearer ${token}`)
  if (connection.provider === "anthropic") {
    headers.set("anthropic-version", "2023-06-01")
    headers.set("anthropic-dangerous-direct-browser-access", "true")
  }
  const url = new URL(connection.endpoint)
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value)
  const redact = (text: string) => token ? text.split(token).join("[redacted]") : text
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await fetch(url.href, { method: request.method ?? "GET", headers, body: request.body, signal, credentials: "omit", redirect: "error" })
    const limit = 1024 * 1024
    if (Number(response.headers.get("content-length")) > limit) throw new AiError("AI response is too large")
    reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let text = "", sent = 0, size = 0
    const progress = (done: boolean) => {
      let end = done ? text.length : Math.max(0, text.length - token.length + 1)
      for (let found; token && (found = text.indexOf(token, Math.max(sent, end - token.length + 1))) >= 0 && found < end;) end = found + token.length
      if (end > sent) { onChunk?.(redact(text.slice(sent, end))); sent = end }
    }
    while (reader) {
      signal?.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) throw new AiError("AI response is too large")
      text += decoder.decode(chunk.value, { stream: true })
      progress(false)
    }
    text += decoder.decode()
    progress(true)
    signal?.throwIfAborted()
    return { status: response.status, headers: { "content-type": redact(response.headers.get("content-type") ?? ""), "retry-after": redact(response.headers.get("retry-after") ?? "") }, text: redact(text) }
  } catch (error) {
    if (signal?.aborted) throw new AiError("Request cancelled", "cancelled")
    if (error instanceof AiError) throw error
    throw new AiError("Connection request failed. Check the endpoint, network access, and redirect policy.")
  } finally { await reader?.cancel().catch(() => undefined) }
}
