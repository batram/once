import { AiSettings, emptyAiSettings, readAiSettings } from "@once/core"
import { SyncVault } from "../SyncVault"
import { OncePlatformPorts } from "../types"
import { withLock } from "../tabsync/locks"

export interface AiData { settings: AiSettings; secrets: Record<string, string> }
export const AI_LOCAL_KEY = "once:ai-local"
export class AiStore {
  readonly vault: SyncVault
  constructor(private readonly platform: OncePlatformPorts, private readonly changed: () => void, vault?: SyncVault) {
    this.vault = vault ?? new SyncVault(platform.listStore, platform.secretStore, changed)
  }
  private async local(): Promise<AiData> {
    const stored = await this.platform.secretStore?.get(AI_LOCAL_KEY)
    const data = stored ? JSON.parse(stored) as AiData : { settings: emptyAiSettings(), secrets: {} }
    return { settings: readAiSettings(data.settings), secrets: data.secrets }
  }
  async read(): Promise<AiData> {
    if (await this.vault.participates("ai")) {
      const data = await this.vault.read()
      if (data?.ai) return { settings: readAiSettings(data.ai), secrets: Object.fromEntries(Object.entries(data.secrets).filter(([key]) => key.startsWith("ai:"))) }
    }
    return this.local()
  }
  update(change: (data: AiData) => void | Promise<void>): Promise<void> {
    return withLock("once:ai-settings", async () => {
      if (await this.vault.participates("ai")) await this.vault.update(async vault => {
        const data = vault.ai ? { settings: readAiSettings(vault.ai), secrets: Object.fromEntries(Object.entries(vault.secrets).filter(([key]) => key.startsWith("ai:"))) } : await this.local()
        await change(data)
        vault.ai = readAiSettings(data.settings)
        vault.secrets = { ...Object.fromEntries(Object.entries(vault.secrets).filter(([key]) => !key.startsWith("ai:"))), ...data.secrets }
      })
      else {
        if (!this.platform.secretStore) throw new Error("This platform has no local AI credential store")
        const data = await this.local()
        await change(data)
        data.settings = readAiSettings(data.settings)
        await this.platform.secretStore.set(AI_LOCAL_KEY, JSON.stringify(data))
      }
      this.changed()
    })
  }
  async enable(): Promise<void> {
    await withLock("once:ai-settings", async () => {
      if ((await this.vault.status()).state !== "ready") throw new Error("Set up and unlock encrypted sync in Settings → Sync first")
      const data = await this.local()
      await this.vault.update(vault => {
        if (!vault.ai) { vault.ai = data.settings; vault.secrets = { ...vault.secrets, ...data.secrets } }
      })
      await this.vault.setParticipation("ai", true)
    })
    this.changed()
  }
  async leave(): Promise<void> {
    await withLock("once:ai-settings", async () => {
      const data = await this.read()
      if (!this.platform.secretStore) throw new Error("This platform has no local AI credential store")
      const serialized = JSON.stringify(data)
      await this.platform.secretStore.set(AI_LOCAL_KEY, serialized)
      if (await this.platform.secretStore.get(AI_LOCAL_KEY) !== serialized) throw new Error("Could not verify the local AI copy")
      await this.vault.setParticipation("ai", false)
    })
    this.changed()
  }
}
