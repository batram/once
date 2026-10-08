import { AddonManifest, AddonModel, AddonRequest, AddonResponse, addonEndpoint, addonModelsUrl, readAddonModels, readAddonRequest } from "@once/core"
import type { SecretStorePort } from "./types"

export class AddonConnections {
  constructor(private readonly fetch: typeof globalThis.fetch, private readonly secrets?: SecretStorePort) {}

  private key(addon: string, field: string): string {
    if (!/^[a-z0-9-]{3,40}$/.test(addon) || !/^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/.test(field)) throw new Error("Invalid addon secret name")
    return `addon:${addon}:${field}`
  }

  async save(addon: string, field: string, endpoint: string, value: string): Promise<void> {
    if (!this.secrets) throw new Error("This platform has no device-local secret store")
    if (value.length > 8192 || /[\r\n]/.test(value)) throw new Error("Invalid API token")
    await this.secrets.set(this.key(addon, field), value ? JSON.stringify({ endpoint: addonEndpoint(endpoint), value }) : "")
  }

  async configured(addon: string, field: string, endpoint: string): Promise<boolean> {
    try { return !!await this.secret(addon, field, endpoint) } catch { return false }
  }

  private async secret(addon: string, field: string, endpoint: string): Promise<string> {
    const stored = await this.secrets?.get(this.key(addon, field))
    if (!stored) return ""
    const binding = JSON.parse(stored)
    if (binding.endpoint !== addonEndpoint(endpoint)) throw new Error("Endpoint changed: replace the token in Add-ons settings before sending it to this destination")
    return typeof binding.value === "string" ? binding.value : ""
  }

  /** The models a connection's provider offers, read with the connection's credential from its declared list URL. */
  async models(manifest: AddonManifest, options: Record<string, unknown>, id: string, signal?: AbortSignal): Promise<AddonModel[]> {
    const connection = manifest.connections?.find(item => item.id === id)
    if (!connection) throw new Error("Connection is not declared by this addon")
    if (!connection.models) throw new Error("This connection does not list its models")
    const endpoint = addonEndpoint(options[connection.endpoint])
    const url = addonModelsUrl(endpoint, connection.models)
    const token = connection.secret ? await this.secret(manifest.id, connection.secret, endpoint) : ""
    signal?.throwIfAborted()
    const headers = new Headers({ accept: "application/json" })
    // Anthropic's API, the x-api-key user, wants its version header on every
    // request, and refuses a browser's request without the opt-in header.
    if (connection.auth === "x-api-key") {
      headers.set("anthropic-version", "2023-06-01")
      headers.set("anthropic-dangerous-direct-browser-access", "true")
    }
    if (token) headers.set(connection.auth === "x-api-key" ? "x-api-key" : "authorization", connection.auth === "x-api-key" ? token : `Bearer ${token}`)
    let response: Response
    let text: string
    try {
      response = await this.fetch(url, { method: "GET", headers, signal, credentials: "omit", redirect: "error" })
      text = await boundedText(response, signal)
    } catch (error) {
      if (signal?.aborted) throw new Error("Request cancelled")
      if (error instanceof Error && error.message === "Response is too large") throw error
      throw new Error("The model list request failed. Check the endpoint and network access.")
    }
    if (response.status === 401 || response.status === 403) throw new Error(`The provider refused the token (HTTP ${response.status})`)
    if (response.status !== 200) throw new Error(`The model list request failed (HTTP ${response.status})`)
    return readAddonModels(text)
  }

  async request(manifest: AddonManifest, options: Record<string, unknown>, id: string, raw: AddonRequest, signal?: AbortSignal,
    onChunk?: (text: string) => void): Promise<AddonResponse> {
    const connection = manifest.connections?.find(item => item.id === id)
    if (!connection) throw new Error("Connection is not declared by this addon")
    const endpoint = addonEndpoint(options[connection.endpoint])
    const request = readAddonRequest(raw)
    const token = connection.secret ? await this.secret(manifest.id, connection.secret, endpoint) : ""
    signal?.throwIfAborted()
    const headers = new Headers(request.headers)
    if (token) headers.set(connection.auth === "x-api-key" ? "x-api-key" : "authorization", connection.auth === "x-api-key" ? token : `Bearer ${token}`)
    const url = new URL(endpoint)
    for (const [name, value] of Object.entries(request.query ?? {})) url.searchParams.set(name, value)
    try {
      const response = await this.fetch(url.href, {
        method: request.method, headers, body: request.body, signal,
        credentials: "omit", redirect: "error"
      })
      signal?.throwIfAborted()
      const redact = (text: string) => token ? text.split(token).join("[redacted]") : text
      const text = await boundedText(response, signal, onChunk && redactedStream(redact, token, onChunk))
      const returnedHeaders: Record<string, string> = {}
      for (const name of ["content-type", "retry-after"]) {
        const value = response.headers.get(name)
        if (value) returnedHeaders[name] = redact(value)
      }
      return { status: response.status, headers: returnedHeaders, text: redact(text) }
    } catch (error) {
      if (signal?.aborted) throw new Error("Request cancelled")
      if (error instanceof Error && error.message === "Response is too large") throw error
      throw new Error("Connection request failed. Check the endpoint, network access, and redirect policy.")
    }
  }
}

/**
 * Hands on body text as it arrives, redacted. A token can straddle two
 * chunks, so the last characters that could still begin one stay back until
 * the next chunk shows what they are, or the body ends.
 */
function redactedStream(redact: (text: string) => string, token: string, onChunk: (text: string) => void): (text: string, done: boolean) => void {
  let received = ""
  let sent = 0
  return (text, done) => {
    received += text
    let safe = done ? received.length : received.length - Math.max(0, token.length - 1)
    // A whole token may cross the cut; the cut moves past it.
    for (let found; token && (found = received.indexOf(token, Math.max(sent, safe - token.length + 1))) >= 0 && found < safe;) safe = found + token.length
    if (safe <= sent) return
    onChunk(redact(received.slice(sent, safe)))
    sent = safe
  }
}

async function boundedText(response: Response, signal?: AbortSignal, progress?: (text: string, done: boolean) => void): Promise<string> {
  const limit = 1024 * 1024
  if (Number(response.headers.get("content-length")) > limit) throw new Error("Response is too large")
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ""
  try {
    while (true) {
      signal?.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) {
        const rest = decoder.decode()
        progress?.(rest, true)
        return text + rest
      }
      size += chunk.value.byteLength
      if (size > limit) throw new Error("Response is too large")
      const decoded = decoder.decode(chunk.value, { stream: true })
      progress?.(decoded, false)
      text += decoded
    }
  } finally { await reader.cancel().catch(() => undefined) }
}
