import { AddonManifest, AddonRequest, AddonResponse, addonEndpoint, readAddonRequest } from "@once/core"
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

  async request(manifest: AddonManifest, options: Record<string, unknown>, id: string, raw: AddonRequest, signal?: AbortSignal): Promise<AddonResponse> {
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
      const text = await boundedText(response, signal)
      const returnedHeaders: Record<string, string> = {}
      for (const name of ["content-type", "retry-after"]) {
        const value = response.headers.get(name)
        if (value) returnedHeaders[name] = token ? value.split(token).join("[redacted]") : value
      }
      return { status: response.status, headers: returnedHeaders, text: token ? text.split(token).join("[redacted]") : text }
    } catch (error) {
      if (signal?.aborted) throw new Error("Request cancelled")
      if (error instanceof Error && error.message === "Response is too large") throw error
      throw new Error("Connection request failed. Check the endpoint, network access, and redirect policy.")
    }
  }
}

async function boundedText(response: Response, signal?: AbortSignal): Promise<string> {
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
      if (chunk.done) return text + decoder.decode()
      size += chunk.value.byteLength
      if (size > limit) throw new Error("Response is too large")
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally { await reader.cancel().catch(() => undefined) }
}
