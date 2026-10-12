import { removedConsumers } from "./removedConsumers"
import { observeAiSettings } from "./observeAiSettings"
import { LegacyAiImport } from "./LegacyAiImport"
import { editConnection, removeConnection, selectModel } from "./settingsMutations"
import { readerAiMethods } from "./readerAi"
import { AiService } from "./AiService"
import { AddonSync } from "../AddonSync"
import { OnceClient, OncePlatformPorts } from "../types"
import { migrateWhat4 } from "./migrateWhat4"

export function aiClientMethods(ai: AiService, addons: AddonSync, platform: OncePlatformPorts): Pick<OnceClient,
  "listAiConnections" | "getAiSettings" | "saveAiSettings" | "saveAiToken" | "hasAiToken" | "listAiModels" | "resolveAiModel" | "generateAi" | "querySearch" |
  "getLegacyAiImportStatus" | "importLegacyAiVault" | "editAiConnection" | "removeAiConnection" | "setAiModel" | "setDefaultSearch" | "migrateAiSettings" | "unlockSyncVault" | "getSyncVaultStatus" | "getSyncDatasets" | "setSyncDataset"> {
  const legacy = new LegacyAiImport(platform, ai.store)
  const migrate = async () => { if (!await legacy.run()) return false; return migrateWhat4(ai, addons, platform) }
  return {
    getAiSettings: () => ai.settings(),
    saveAiSettings: settings => ai.save(settings), saveAiToken: (id, endpoint, token) => ai.saveToken(id, endpoint, token), hasAiToken: id => ai.hasToken(id),
    listAiConnections: async () => (await ai.settings()).connections.map(({ id, name, provider }) => ({ id, name, provider })),
    listAiModels: (id, signal) => ai.models(id, signal),
    resolveAiModel: (consumer, selection) => ai.resolve(consumer, selection),
    generateAi: (consumer, request, signal, onText) => ai.generate(consumer, request, signal, onText),
    querySearch: (query, id, signal) => ai.search(query, id, signal),
    getLegacyAiImportStatus: () => legacy.status(),
    importLegacyAiVault: (secret, recovery) => legacy.run(secret, recovery),
    editAiConnection: edit => editConnection(ai.store, edit),
    removeAiConnection: (id, expected) => removeConnection(ai.store, id, expected),
    setAiModel: (consumer, selection) => selectModel(ai.store, consumer, selection),
    setDefaultSearch: id => ai.store.update(data => {
      if (id && !data.settings.searchConnections.some(item => item.id === id)) throw new Error("The search connection was removed")
      data.settings.defaultSearch = id
    }),
    migrateAiSettings: migrate,
    unlockSyncVault: (secret, recovery, remember, name) => addons.vault.unlock(secret, recovery, remember, name),
    getSyncVaultStatus: () => addons.vault.status(),
    getSyncDatasets: async () => ({ addons: await addons.vault.participates("addons"), ai: await addons.vault.participates("ai") }),
    setSyncDataset: async (dataset, enabled) => {
      if (dataset === "addons") await addons.setEnabled(enabled)
      else if (enabled) await ai.store.enable()
      else await ai.store.leave()
    }
  }
}

export function createAiClient(platform: OncePlatformPorts, addons: AddonSync, changed: () => void) {
  const ai = new AiService(platform, changed, addons.vault)
  let localConsumers = new Set<string>()
  const cleanup = removedConsumers(platform, ai.store, () => localConsumers)
  addons.onRemoved = cleanup
  const methods = aiClientMethods(ai, addons, platform)
  observeAiSettings(platform, changed)
  return { registerLocalAiConsumers: (ids: string[]) => { localConsumers = new Set(ids) }, ...methods,
    migrateAiSettings: async () => { await cleanup(); return methods.migrateAiSettings() },
    unlockSyncVault: async (...args: Parameters<OnceClient["unlockSyncVault"]>) => { await methods.unlockSyncVault(...args); await cleanup() },
    ...readerAiMethods(platform, methods.generateAi) }
}
