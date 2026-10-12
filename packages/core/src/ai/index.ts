import { addonEndpoint } from "../addons/connections"

export type AiProvider = "openai" | "anthropic" | "compatible"
export interface AiSelection { connection: string; model: string }
export interface AiConnection {
  id: string
  name: string
  provider: AiProvider
  endpoint: string
  workspace?: string
  effort?: "default" | "low" | "medium" | "high"
}
export interface SearchConnection { id: string; name: string; provider: "searxng" | "tavily"; endpoint: string }
export interface AiSettings {
  connections: AiConnection[]
  defaultModel?: AiSelection
  overrides: Record<string, AiSelection>
  searchConnections: SearchConnection[]
  defaultSearch?: string
  migrations?: string[]
}
export interface AiImage { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp"; base64: string }
export type AiContent = { type: "text"; text: string } | AiImage
export interface AiMessage { role: "user" | "assistant"; content: string | AiContent[] }
export interface AiRequest {
  selection?: AiSelection
  expectedRevision?: string
  instructions: string
  messages: AiMessage[]
  maxOutputTokens?: number
  effort?: "default" | "low" | "medium" | "high"
  search?: boolean
  fetchPage?: boolean
}
export interface AiModel { id: string; name: string }
export interface AiResolvedModel extends AiSelection { provider: AiProvider; name: string; revision: string }
export interface AiSource { title: string; url: string }
export interface AiResult { text: string; sources: AiSource[]; fetched: boolean; model: AiResolvedModel }
export interface SearchResult extends AiSource { id: string; snippet: string }
export class AiError extends Error {
  constructor(message: string, readonly code: "setup" | "request" | "unsupported-search" | "unsupported-fetch" | "search" | "cancelled" | "busy" | "timeout" | "configuration-changed" = "request") { super(message) }
}
export const emptyAiSettings = (): AiSettings => ({ connections: [], overrides: {}, searchConnections: [] })
export const AI_VAULT_ID = "ai_vault"
export const AI_IMAGE_LIMIT = 20 * 1024 * 1024
export const AI_TEXT_LIMIT = 1024 * 1024
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,99}$/
export function readAiSelection(value: unknown): AiSelection {
  const raw = value as AiSelection | null
  if (!raw || typeof raw.connection !== "string" || !identifier.test(raw.connection) || typeof raw.model !== "string" || !raw.model.trim() || raw.model.length > 200 || /[\r\n]/.test(raw.model)) throw new Error("Choose a connection and model in AI & Search settings")
  return { connection: raw.connection, model: raw.model.trim() }
}
export function readAiSettings(value: unknown): AiSettings {
  const raw = value as AiSettings | null
  if (!raw || !Array.isArray(raw.connections) || !Array.isArray(raw.searchConnections) || !raw.overrides || Array.isArray(raw.overrides) || raw.connections.length + raw.searchConnections.length > 40) throw new Error("Invalid AI settings")
  const ids = new Set<string>()
  const connection = <T extends AiConnection | SearchConnection>(item: T): T => {
    if (!item || !identifier.test(item.id) || ids.has(item.id) || typeof item.name !== "string" || item.name.length > 100) throw new Error("Invalid or duplicate connection")
    ids.add(item.id)
    return { ...item, endpoint: addonEndpoint(item.endpoint) }
  }
  const connections = raw.connections.map(item => {
    if (!["openai", "anthropic", "compatible"].includes(item.provider) || (item.workspace !== undefined && (typeof item.workspace !== "string" || item.workspace.length > 200 || /[\r\n]/.test(item.workspace))) || (item.effort !== undefined && !["default", "low", "medium", "high"].includes(item.effort))) throw new Error("Invalid AI connection")
    return connection(item)
  })
  const searchConnections = raw.searchConnections.map(item => {
    if (!["searxng", "tavily"].includes(item.provider)) throw new Error("Invalid search connection")
    return connection(item)
  })
  const overrides = Object.fromEntries(Object.entries(raw.overrides).map(([key, selection]) => {
    if (!identifier.test(key)) throw new Error("Invalid AI consumer")
    return [key, readAiSelection(selection)]
  }))
  return { connections, searchConnections, overrides, ...(raw.defaultModel ? { defaultModel: readAiSelection(raw.defaultModel) } : {}), ...(typeof raw.defaultSearch === "string" ? { defaultSearch: raw.defaultSearch } : {}), ...(raw.migrations ? { migrations: raw.migrations.filter(key => typeof key === "string").slice(0, 100) } : {}) }
}
export function readAiRequest(value: unknown): AiRequest {
  const raw = value as AiRequest | null
  if (!raw || typeof raw.instructions !== "string" || !Array.isArray(raw.messages) || !raw.messages.length || raw.messages.length > 100) throw new Error("Invalid AI request")
  let images = 0
  let textBytes = new TextEncoder().encode(raw.instructions).length
  const messages = raw.messages.map(message => {
    if (!message || !["user", "assistant"].includes(message.role)) throw new Error("Invalid AI message")
    const content = message.content
    if (typeof content === "string") textBytes += new TextEncoder().encode(content).length
    else if (Array.isArray(content) && content.length <= 20) for (const part of content) {
      if (part.type === "text" && typeof part.text === "string") textBytes += new TextEncoder().encode(part.text).length
      else if (part.type === "image" && ["image/png", "image/jpeg", "image/webp"].includes(part.mediaType) && typeof part.base64 === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(part.base64) && part.base64.length % 4 === 0 && part.base64.length > 0) images += part.base64.length * 3 / 4
      else throw new Error("Invalid AI content")
    } else throw new Error("Invalid AI content")
    return { role: message.role, content }
  })
  if (images > AI_IMAGE_LIMIT || textBytes > AI_TEXT_LIMIT) throw new Error("AI request is too large")
  if (raw.maxOutputTokens !== undefined && (!Number.isInteger(raw.maxOutputTokens) || raw.maxOutputTokens < 1 || raw.maxOutputTokens > 32000)) throw new Error("Invalid AI output limit")
  if (raw.effort !== undefined && !["default", "low", "medium", "high"].includes(raw.effort)) throw new Error("Invalid AI effort")
  if (raw.expectedRevision !== undefined && (typeof raw.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(raw.expectedRevision))) throw new Error("Invalid AI configuration revision")
  return { expectedRevision: raw.expectedRevision, instructions: raw.instructions, messages, ...(raw.selection ? { selection: readAiSelection(raw.selection) } : {}), maxOutputTokens: raw.maxOutputTokens, effort: raw.effort, search: raw.search === true, fetchPage: raw.fetchPage === true }
}
export * from "./readerProtocol"
