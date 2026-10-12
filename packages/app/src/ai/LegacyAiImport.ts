import { AI_VAULT_ID, AiConnection, AiSelection } from "@once/core"
import { SyncVault } from "../SyncVault"
import { OncePlatformPorts } from "../types"
import { AiStore } from "./AiStore"
import { canonical } from "../vaultData"

/** Recovery-only reader for the superseded draft vault. Never creates a second vault. */
export class LegacyAiImport {
  private readonly legacy: SyncVault
  constructor(platform: OncePlatformPorts, private readonly target: AiStore) {
    const store = platform.listStore
    this.legacy = new SyncVault({
      get: (id, fallback) => store.get(id, fallback), set: (id, value) => store.set(id, value),
      readVault: store.readVault && (() => store.readVault?.(AI_VAULT_ID) ?? Promise.resolve([])),
      writeVault: store.writeVault && ((value, parents) => store.writeVault?.(value, parents, AI_VAULT_ID) ?? Promise.reject(new Error("Legacy sync unavailable")))
    }, platform.secretStore, () => undefined, "once:ai-vault")
  }
  async status(): Promise<string | null> {
    if (await this.legacy.left()) return null
    const status = await this.legacy.status()
    if (status.state === "disabled" || status.state === "unavailable") return null
    return status.state === "ready" ? "An earlier AI vault is ready to import into shared sync." : "An earlier AI vault needs its old passphrase or recovery key once before it can join shared sync. Its data has been retained."
  }
  async run(secret?: string, recovery = false): Promise<boolean> {
    if (!await this.status()) return true
    if ((await this.target.vault.status()).state !== "ready") return false
    if (secret) await this.legacy.unlock(secret, recovery, false, "")
    if ((await this.legacy.status()).state !== "ready") return false
    const source = await this.legacy.read()
    if (!source?.ai) return true
    const imported = source.ai
    await this.target.enable()
    const marker = `draft-ai:${source.commit}`
    await this.target.update(data => {
      if (data.settings.migrations?.includes(marker)) return
      const ids = new Map<string, string>()
      for (const original of [...imported.connections, ...imported.searchConnections]) {
        const all = [...data.settings.connections, ...data.settings.searchConnections]
        const binding = source.secrets[`ai:${original.id}`]
        const same = all.find(item => canonical({ ...item, id: "" }) === canonical({ ...original, id: "" }) && data.secrets[`ai:${item.id}`] === binding)
        if (same) { ids.set(original.id, same.id); continue }
        let id = original.id
        for (let suffix = 1; all.some(item => item.id === id); suffix++) id = `${original.id}-import-${suffix}`
        ids.set(original.id, id)
        if (original.provider === "searxng" || original.provider === "tavily") data.settings.searchConnections.push({ ...original, id })
        else data.settings.connections.push({ ...original, id } as AiConnection)
        if (binding) data.secrets[`ai:${id}`] = binding
      }
      const mapped = (selection: AiSelection): AiSelection => ({ ...selection, connection: ids.get(selection.connection) ?? selection.connection })
      data.settings.defaultModel ??= imported.defaultModel && mapped(imported.defaultModel)
      data.settings.defaultSearch ??= imported.defaultSearch && (ids.get(imported.defaultSearch) ?? imported.defaultSearch)
      for (const [consumer, selection] of Object.entries(imported.overrides)) data.settings.overrides[consumer] ??= mapped(selection)
      data.settings.migrations = [...data.settings.migrations ?? [], marker]
    })
    if (!(await this.target.read()).settings.migrations?.includes(marker)) throw new Error("Could not verify imported AI settings")
    await this.legacy.leave()
    return true
  }
}
