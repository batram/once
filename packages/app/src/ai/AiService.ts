import { canonical } from "../vaultData"
import { AiData } from "./AiStore"
import { AiRequestRunner } from "./requestRunner"
import { SyncVault } from "../SyncVault"
import { AiError, AiRequest, AiResolvedModel, AiResult, AiSelection, AiSettings, AiModel, SearchResult, readAiRequest, readAiSettings, readAddonModels, addonModelsUrl } from "@once/core"
import { OncePlatformPorts } from "../types"
import { AiStore } from "./AiStore"
import { aiTransport } from "./transport"
import { providerRequest, providerResult, responseJson, streamReader, streamedResponse, safeSources } from "./providers"

export class AiService {
  private readonly runner = new AiRequestRunner()
  readonly store: AiStore
  constructor(private readonly platform: OncePlatformPorts, changed: () => void, vault?: SyncVault) { this.store = new AiStore(platform, changed, vault) }
  async settings(): Promise<AiSettings> { return (await this.store.read()).settings }
  save(settings: AiSettings): Promise<void> { return this.store.update(data => { data.settings = readAiSettings(settings) }) }
  async resolve(consumer: string, selection?: AiSelection): Promise<AiResolvedModel> {
    return this.resolveFrom(await this.store.read(), consumer, selection)
  }
  private async resolveFrom(data: AiData, consumer: string, selection?: AiSelection): Promise<AiResolvedModel> {
    const chosen = selection ?? data.settings.overrides[consumer] ?? data.settings.defaultModel
    const connection = data.settings.connections.find(item => item.id === chosen?.connection)
    if (!chosen || !connection) throw new AiError("Choose a connection and model in Settings → AI & Search", "setup")
    if (connection.provider !== "compatible" && !this.token(data.secrets, connection.id, connection.endpoint)) throw new AiError(`Add a token for ${connection.name} in Settings → AI & Search`, "setup")
    const bytes = new TextEncoder().encode(canonical({ connection, model: chosen.model, binding: data.secrets[`ai:${connection.id}`] ?? "" }))
    const revision = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("")
    return { ...chosen, provider: connection.provider, name: connection.name, revision }
  }

  saveToken(id: string, endpoint: string, value: string): Promise<void> {
    if (value.length > 8192 || /[\r\n]/.test(value)) return Promise.reject(new Error("Invalid API token"))
    return this.store.update(data => {
      const connection = [...data.settings.connections, ...data.settings.searchConnections].find(item => item.id === id)
      if (!connection || connection.endpoint !== new URL(endpoint).href) throw new Error("Save the connection endpoint before replacing its token")
      if (value) data.secrets[`ai:${id}`] = JSON.stringify({ endpoint: connection.endpoint, value })
      else data.secrets = Object.fromEntries(Object.entries(data.secrets).filter(([key]) => key !== `ai:${id}`))
    })
  }
  async hasToken(id: string): Promise<boolean> {
    const { settings, secrets } = await this.store.read()
    const connection = [...settings.connections, ...settings.searchConnections].find(item => item.id === id)
    try { return !!connection && !!this.token(secrets, connection.id, connection.endpoint) } catch { return false }
  }
  private token(secrets: Record<string, string>, id: string, endpoint: string): string {
    const stored = secrets[`ai:${id}`]
    if (!stored) return ""
    const binding = JSON.parse(stored) as { endpoint: string; value: string }
    if (binding.endpoint !== endpoint) throw new AiError("Endpoint changed: replace the token in AI & Search settings before sending it to this destination", "setup")
    if (typeof binding.value !== "string") throw new AiError("Replace the invalid credential in AI & Search settings", "setup")
    return binding.value
  }
  models(id: string, signal?: AbortSignal): Promise<AiModel[]> {
    return this.runner.run("models", signal, active => this.modelsNow(id, active))
  }
  private async modelsNow(id: string, signal?: AbortSignal): Promise<AiModel[]> {
    const { settings, secrets } = await this.store.read()
    const connection = settings.connections.find(item => item.id === id)
    if (!connection) throw new AiError("AI connection no longer exists", "setup")
    if (connection.provider !== "compatible" && !this.token(secrets, id, connection.endpoint)) throw new AiError(`Add a token for ${connection.name} in AI & Search settings`, "setup")
    const endpoint = addonModelsUrl(connection.endpoint, connection.provider === "compatible" ? "../models" : "models")
    const response = await aiTransport(this.platform.addonFetch ?? this.platform.fetch, { ...connection, endpoint }, this.token(secrets, id, connection.endpoint), {}, signal)
    if (response.status !== 200) throw new AiError(`Model discovery failed (HTTP ${response.status}). Check the endpoint and token.`)
    return readAddonModels(response.text)
  }
  generate(consumer: string, raw: AiRequest, signal?: AbortSignal, onText?: (text: string) => void): Promise<AiResult> {
    return this.runner.run(consumer, signal, active => this.generateNow(consumer, raw, active, onText && (text => { if (!active.aborted) onText(text) })))
  }
  private async generateNow(consumer: string, raw: AiRequest, signal?: AbortSignal, onText?: (text: string) => void): Promise<AiResult> {
    const request = readAiRequest(raw)
    const snapshot = await this.store.read()
    const model = await this.resolveFrom(snapshot, consumer, request.selection)
    if (request.expectedRevision && request.expectedRevision !== model.revision) throw new AiError("The selected AI connection changed. Review the model and try again.", "configuration-changed")
    const { settings, secrets } = snapshot
    const connection = settings.connections.find(item => item.id === model.connection)
    if (!connection) throw new AiError("AI connection no longer exists", "setup")
    if (request.search && model.provider === "compatible") throw new AiError("This connection does not offer native search", "unsupported-search")
    if (request.fetchPage && model.provider !== "anthropic") throw new AiError("This connection does not offer page fetching", "unsupported-fetch")
    const payload = providerRequest({ ...connection, model: model.model, effort: request.effort ?? connection.effort, maxOutputTokens: request.maxOutputTokens }, request.instructions, "", request.messages, request.search, !!onText, request.fetchPage)
    const response = await aiTransport(this.platform.addonFetch ?? this.platform.fetch, connection, this.token(secrets, connection.id, connection.endpoint), payload, signal, onText ? streamReader(model.provider, onText) : undefined)
    if (response.status === 400 && /tool|search|fetch/i.test(response.text)) {
      if (request.fetchPage) throw new AiError("The model does not support page fetching", "unsupported-fetch")
      if (request.search) throw new AiError("The model does not support native search", "unsupported-search")
    }
    const data = /text\/event-stream/i.test(response.headers["content-type"]) && response.status >= 200 && response.status < 300 ? streamedResponse(model.provider, response.text) : responseJson(response)
    if (request.search && Array.isArray(data.content) && data.content.some((block: { type?: string; content?: { type?: string } }) => block?.type === "web_search_tool_result" && block.content?.type === "web_search_tool_result_error")) throw new AiError("The provider's web search failed", "search")
    return { ...providerResult(model.provider, data), model } as AiResult
  }
  search(query: string, id?: string, signal?: AbortSignal): Promise<SearchResult[]> {
    return this.runner.run("search", signal, active => this.searchNow(query, id, active))
  }
  private async searchNow(query: string, id?: string, signal?: AbortSignal): Promise<SearchResult[]> {
    if (typeof query !== "string" || !query.trim() || query.length > 4096) throw new Error("Invalid search query")
    const { settings, secrets } = await this.store.read()
    const connection = settings.searchConnections.find(item => item.id === (id ?? settings.defaultSearch))
    if (!connection) throw new AiError("Configure a search connection in Settings → AI & Search", "setup")
    const request = connection.provider === "tavily" ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, max_results: 5 }) } : { query: { q: query, format: "json" } }
    const response = await aiTransport(this.platform.addonFetch ?? this.platform.fetch, connection, this.token(secrets, connection.id, connection.endpoint), request, signal)
    const data = responseJson(response) as { results?: { title: string; url: string; content?: string }[] }
    if (!Array.isArray(data.results)) throw new AiError("Search returned an invalid response", "search")
    const results = data.results
    return safeSources(results).slice(0, 5).map((source: { title: string; url: string }, index: number) => ({ ...source, id: `S${index + 1}`, snippet: String(results.find(item => item.url === source.url)?.content ?? "").slice(0, 2000) }))
  }
}
