import { AddonEntry, AddonManifest, AddonsDocument, addonEndpoint, emptyAddonsDocument, readAddonsDocument, validateConfig } from "@once/core"
import { AppSettings } from "./AppSettings"
import { AddonVault } from "./AddonVault"
import { AddonConnections } from "./addonConnections"
import { getAddonScript, storeAddonScript } from "./addonScriptCache"
import { fetchText } from "./fetchDocument"
import { OnceClient, OncePlatformPorts } from "./types"
import { VaultData, verifyVaultScript } from "./vaultData"

export class AddonSync {
  readonly vault: AddonVault
  private readonly local: AddonConnections
  private readonly synced: AddonConnections
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private readonly platform: OncePlatformPorts, private readonly settings: AppSettings, changed: () => void) {
    this.vault = new AddonVault(platform.listStore, platform.secretStore, changed)
    this.local = new AddonConnections(platform.addonFetch ?? platform.fetch, platform.secretStore)
    this.synced = new AddonConnections(platform.addonFetch ?? platform.fetch, {
      get: async name => (await this.vault.read())?.secrets[name] ?? "",
      set: (name, value) => this.vault.update(data => {
        data.secrets = Object.fromEntries(Object.entries(data.secrets).filter(([key]) => key !== name))
        if (value) data.secrets[name] = value
      })
    })
  }

  async document(): Promise<AddonsDocument> {
    try { return await this.vault.enabled() ? (await this.vault.read())?.document ?? emptyAddonsDocument() : await this.settings.getAddons() }
    catch { return emptyAddonsDocument() } // Fail closed: dispose installed runtimes while locked or conflicted.
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(work)
    this.writes = pending.catch(() => undefined)
    return pending
  }

  update(change: (doc: AddonsDocument) => AddonsDocument): Promise<void> {
    return this.serialize(() => this.updateNow(change))
  }

  private async updateNow(change: (doc: AddonsDocument) => AddonsDocument): Promise<void> {
    if (!await this.vault.enabled()) return this.settings.updateAddons(change)
    await this.vault.update(async data => {
      data.document = readAddonsDocument(change(data.document))
      await this.packages(data)
      const ids = new Set(data.document.addons.map(item => item.manifest.id))
      data.secrets = Object.fromEntries(Object.entries(data.secrets).filter(([name]) => ids.has(name.split(":")[1])))
    })
  }

  private async packages(data: VaultData): Promise<void> {
    const scripts: Record<string, string> = {}
    for (const { manifest } of data.document.addons) {
      if (!manifest.script) continue
      const { integrity, url } = manifest.script
      let code = data.scripts[integrity] ?? await getAddonScript(this.platform.cacheStore, integrity)
      if (code === null || code === undefined) {
        if (!/^https?:/.test(url)) throw new Error(`Import ${manifest.name} on this device before syncing its package`)
        code = await fetchText(this.platform.fetch, url)
      }
      await verifyVaultScript(integrity, code)
      scripts[integrity] = code
    }
    data.scripts = scripts
  }

  create(passphrase: string, remember: boolean, deviceName: string): Promise<{ recoveryKey: string; warning?: string }> {
    return this.serialize(() => this.createNow(passphrase, remember, deviceName))
  }

  private async createNow(passphrase: string, remember: boolean, deviceName: string): Promise<{ recoveryKey: string; warning?: string }> {
    const data: VaultData = { document: await this.settings.getAddons(), secrets: {}, scripts: {}, generation: 1,
      commit: "", author: "", updatedAt: "" }
    for (const { manifest } of data.document.addons) for (const connection of manifest.connections ?? []) {
      if (!connection.secret) continue
      const name = `addon:${manifest.id}:${connection.secret}`
      const value = await this.platform.secretStore?.get(name)
      if (value) data.secrets[name] = value
    }
    await this.packages(data)
    const result = await this.vault.create(passphrase, remember, deviceName, data)
    // Retire the unprotected document so older clients don't activate stale packages.
    // Failure here must not hide the newly generated recovery key from the user.
    let warning = result.warning
    try {
      await this.settings.saveAddons(emptyAddonsDocument())
      for (const name of Object.keys(data.secrets)) await this.platform.secretStore?.set(name, "")
    } catch { warning = [warning, "Vault created. Some legacy local data could not be cleared; it is not used by secure addon sync."].filter(Boolean).join(" ") }
    return { recoveryKey: result.recoveryKey, ...(warning ? { warning } : {}) }
  }

  async script(integrity: string): Promise<string | null> {
    if (await this.vault.enabled()) {
      const code = (await this.vault.read())?.scripts[integrity]
      if (code !== undefined) { await verifyVaultScript(integrity, code); return code }
    }
    return getAddonScript(this.platform.cacheStore, integrity)
  }

  private async approved(manifest: AddonManifest, options: Record<string, unknown>, connectionId: string): Promise<void> {
    const entry = (await this.vault.read())?.document.addons.find(item => item.manifest.id === manifest.id)
    if (!entry?.enabled || JSON.stringify(entry.manifest) !== JSON.stringify(manifest)) throw new Error("This addon version is not approved in the synced vault")
    const connection = entry.manifest.connections?.find(item => item.id === connectionId)
    const values = entry.manifest.settings ? validateConfig(entry.manifest.settings, entry.options ?? {}) as Record<string, unknown> : {}
    if (!connection || addonEndpoint(values[connection.endpoint]) !== addonEndpoint(options[connection.endpoint])) throw new Error("The connection changed. Reload the addon before sending a request.")
  }

  private async share(entry: AddonEntry, code: string | null): Promise<void> {
    if (!await this.vault.enabled()) throw new Error("Enable encrypted addon sync first")
    const snapshot = structuredClone(entry)
    if (snapshot.manifest.script) {
      if (code === null) throw new Error("The directory's script is unavailable")
      await verifyVaultScript(snapshot.manifest.script.integrity, code)
      snapshot.manifest.script.url = `once-addon://local/${snapshot.manifest.id}/main.js`
    }
    const normalized = readAddonsDocument({ version: 1, addons: [snapshot] }).addons[0]
    if (!normalized) throw new Error("The directory is not a valid addon")
    await this.vault.update(async data => {
      if (data.document.addons.some(item => item.manifest.id === snapshot.manifest.id)) throw new Error("An installed addon already has this ID")
      data.document.addons.push(normalized)
      if (normalized.manifest.script && code !== null) data.scripts[normalized.manifest.script.integrity] = code
      for (const connection of normalized.manifest.connections ?? []) {
        if (!connection.secret) continue
        const name = `addon:${normalized.manifest.id}:${connection.secret}`
        const local = await this.platform.secretStore?.get(name)
        if (local) data.secrets[name] = local
      }
    })
  }

  methods(): Pick<OnceClient, "getAddonVaultStatus" | "unlockAddonVault" | "lockAddonVault" | "changeAddonVaultPassphrase" |
    "getAddonVaultChoices" | "resolveAddonVault" | "getAddons" | "saveAddons" | "updateAddons" | "getAddonScript" |
    "storeAddonScript" | "saveAddonSecret" | "hasAddonSecret" | "requestAddonConnection" | "shareAddonSnapshot"> {
    return {
      getAddonVaultStatus: () => this.vault.status(),
      shareAddonSnapshot: (entry, code) => this.serialize(() => this.share(entry, code)),
      unlockAddonVault: (secret, recovery, remember, name) => this.vault.unlock(secret, recovery, remember, name),
      lockAddonVault: () => this.vault.lock(),
      changeAddonVaultPassphrase: passphrase => this.vault.update(() => undefined, passphrase),
      getAddonVaultChoices: () => this.vault.choices(),
      resolveAddonVault: (revision, expected) => this.vault.resolve(revision, expected),
      getAddons: () => this.document(),
      saveAddons: doc => this.update(() => doc),
      updateAddons: change => this.update(change),
      getAddonScript: integrity => this.script(integrity),
      storeAddonScript: async (integrity, code) => {
        await verifyVaultScript(integrity, code)
        await storeAddonScript(this.platform.cacheStore, integrity, code)
      },
      saveAddonSecret: (addon, field, endpoint, secret, localOnly) => this.serialize(async () => {
        if (localOnly || !await this.vault.enabled()) return this.local.save(addon, field, endpoint, secret)
        const entry = (await this.vault.read())?.document.addons.find(item => item.manifest.id === addon)
        const connection = entry?.manifest.connections?.find(item => item.secret === field)
        const values = entry?.manifest.settings ? validateConfig(entry.manifest.settings, entry.options ?? {}) as Record<string, unknown> : {}
        if (!connection || addonEndpoint(values[connection.endpoint]) !== addonEndpoint(endpoint)) throw new Error("Save the addon connection settings before its token")
        await this.synced.save(addon, field, endpoint, secret)
      }),
      hasAddonSecret: async (addon, field, endpoint, localOnly) =>
        (localOnly || !await this.vault.enabled() ? this.local : this.synced).configured(addon, field, endpoint),
      requestAddonConnection: async (manifest, options, connection, request, signal, localOnly) => {
        if (localOnly || !await this.vault.enabled()) return this.local.request(manifest, options, connection, request, signal)
        await this.approved(manifest, options, connection)
        return this.synced.request(manifest, options, connection, request, signal)
      }
    }
  }
}
