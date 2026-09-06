import { ConfigSchema } from "./configSchema"

export interface AddonConnection {
  id: string
  endpoint: string
  secret?: string
  auth?: "bearer" | "x-api-key"
}
export interface AddonRequest {
  method?: "GET" | "POST"
  headers?: Record<string, string>
  query?: Record<string, string>
  body?: string
}
export interface AddonResponse {
  status: number
  headers: Record<string, string>
  text: string
}

export function readConnections(value: unknown, schema?: ConfigSchema): AddonConnection[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8) throw new Error("connections must be a list of at most 8 connections")
  const properties = schema?.type === "object" ? schema.properties : {}
  const seen = new Set<string>()
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !/^[a-z][a-z0-9-]{2,39}$/.test(raw.id) || seen.has(raw.id)) {
      throw new Error("connection IDs must be unique identifiers")
    }
    seen.add(raw.id)
    const endpoint = properties[raw.endpoint]
    const secret = properties[raw.secret]
    if (endpoint?.type !== "string" || endpoint.format !== "url") throw new Error("connection endpoint must name a URL setting")
    if (raw.secret !== undefined && (secret?.type !== "string" || secret.format !== "secret")) throw new Error("connection secret must name a secret setting")
    if (raw.auth !== undefined && raw.auth !== "bearer" && raw.auth !== "x-api-key") throw new Error("unsupported connection authentication")
    return { id: raw.id, endpoint: raw.endpoint, secret: raw.secret, auth: raw.auth ?? "bearer" }
  })
}

export function readAddonRequest(value: unknown): AddonRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid connection request")
  const raw = value as AddonRequest
  if (raw.method !== undefined && raw.method !== "GET" && raw.method !== "POST") throw new Error("Only GET and POST are supported")
  if (raw.body !== undefined && (typeof raw.body !== "string" || new TextEncoder().encode(raw.body).length > 1024 * 1024)) {
    throw new Error("Request body is too large")
  }
  const headers = textMap(raw.headers)
  const query = textMap(raw.query)
  for (const name of Object.keys(headers)) {
    if (!["content-type", "accept", "anthropic-version", "anthropic-workspace-id"].includes(name.toLowerCase())) {
      throw new Error("Request header is not allowed")
    }
  }
  return { method: raw.method ?? "GET", body: raw.body, headers, query }
}

function textMap(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 16) throw new Error("Invalid request fields")
  const result: Record<string, string> = {}
  for (const [key, text] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key) || typeof text !== "string" || text.length > 4096 || /[\r\n]/.test(text)) throw new Error("Invalid request field")
    result[key] = text
  }
  return result
}

export function addonEndpoint(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Configure the connection endpoint in Add-ons settings")
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Endpoint must be an HTTP(S) URL without credentials or fragment")
  return url.href
}
