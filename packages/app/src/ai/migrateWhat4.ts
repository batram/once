import { AiConnection, AiProvider, SearchConnection, validateConfig } from "@once/core"
import { AddonSync } from "../AddonSync"
import { OncePlatformPorts } from "../types"
import { AiService } from "./AiService"
import { canonical } from "../vaultData"

/** Explicit upgrade gate: copy and verify the exact source before replacing its package. */
export async function migrateWhat4(ai: AiService, addons: AddonSync, platform: OncePlatformPorts): Promise<boolean> {
  const status = await addons.vault.datasetStatus("addons")
  if (["locked", "conflict", "error"].includes(status.state)) return false
  const entry = (await addons.document()).addons.find(item => item.manifest.id === "what-wait-who-why")
  if (!entry?.manifest.settings) return true
  const options = validateConfig(entry.manifest.settings, entry.options ?? {}) as Record<string, unknown>
  if (!options.provider) return true
  const encrypted = await addons.vault.participates("addons")
  const vault = encrypted ? await addons.vault.read() : null
  const credentials: Record<string, string> = {}
  for (const field of ["openaiToken", "anthropicToken", "compatibleToken", "searchToken", "tavilyToken"]) {
    const key = `addon:${entry.manifest.id}:${field}`
    const value = encrypted ? vault?.secrets[key] : await platform.secretStore?.get(key)
    if (value) credentials[field] = value
  }
  const source = canonical({ options, credentials })
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))), byte => byte.toString(16).padStart(2, "0")).join("")
  const migration = `what4:${hash}`
  if ((await ai.settings()).migrations?.includes(migration)) return true
  // Moving an existing encrypted consumer into the shared AI section keeps it encrypted.
  if (encrypted && !await ai.store.vault.participates("ai")) await ai.store.enable()
  if ((await ai.settings()).migrations?.includes(migration)) return true
  await ai.store.update(data => {
    if (data.settings.migrations?.includes(migration)) return
    const ids: Record<string, string> = {}
    const importConnection = (connection: AiConnection | SearchConnection, field: string, search: boolean) => {
      const all = [...data.settings.connections, ...data.settings.searchConnections]
      const matching = all.find(item => item.provider === connection.provider && item.endpoint === connection.endpoint && data.secrets[`ai:${item.id}`] === credentials[field])
      if (matching) { ids[connection.provider] = matching.id; return }
      const base = connection.id
      for (let suffix = 1; all.some(item => item.id === connection.id); suffix++) connection.id = `${base}-${suffix}`
      if (search) data.settings.searchConnections.push(connection as SearchConnection)
      else data.settings.connections.push(connection as AiConnection)
      if (credentials[field]) data.secrets[`ai:${connection.id}`] = credentials[field]
      ids[connection.provider] = connection.id
    }
    for (const provider of ["openai", "anthropic", "compatible"] as AiProvider[]) {
      const endpoint = String(options[`${provider}Endpoint`] ?? "").trim()
      if (!endpoint || (!credentials[`${provider}Token`] && options.provider !== provider)) continue
      importConnection({ id: `what4-${provider}`, name: provider === "compatible" ? "Compatible (What4)" : `${provider} (What4)`, provider, endpoint: new URL(endpoint).href,
        ...(provider === "anthropic" ? { workspace: String(options.workspace ?? ""), effort: options.effort as AiConnection["effort"] } : {}) }, `${provider}Token`, false)
    }
    for (const provider of ["searxng", "tavily"] as const) {
      const endpoint = String(options[provider === "searxng" ? "searchEndpoint" : "tavilyEndpoint"] ?? "").trim()
      if (!endpoint) continue
      importConnection({ id: `what4-${provider}`, name: `${provider} (What4)`, provider, endpoint: new URL(endpoint).href }, provider === "searxng" ? "searchToken" : "tavilyToken", true)
    }
    if (ids[String(options.provider)] && String(options.model ?? "").trim()) {
      const selection = { connection: ids[String(options.provider)], model: String(options.model).trim() }
      data.settings.overrides[entry.manifest.id] ??= selection
      data.settings.defaultModel ??= selection
    }
    data.settings.defaultSearch ??= ids[String(options.searchProvider)]
    data.settings.migrations = [...data.settings.migrations ?? [], migration]
  })
  return (await ai.settings()).migrations?.includes(migration) === true
}
