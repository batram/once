import { AddonVaultChoice, AddonVaultStatus, VaultRevision } from "@once/core"
import type { ListStorePort, SecretStorePort } from "./types"
import { createEnvelope, decryptVault, encryptVault, randomHex, readEnvelope, rewrapPassword, unlockEnvelope, VaultEnvelope } from "./vaultCrypto"
import { readVaultData, VaultData } from "./vaultData"

const PIN = "once:addon-vault"
interface Pin { id: string; key: string; generation: number; commit: string; deviceName: string }
class VaultStateError extends Error {
  constructor(readonly state: AddonVaultStatus["state"], message: string) { super(message) }
}

/** One encrypted snapshot is also the authenticated approval for its packages and settings. */
export class AddonVault {
  private rawKey = ""
  private pin?: Pin
  private initialized?: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private readonly store: ListStorePort, private readonly secrets: SecretStorePort | undefined,
    private readonly changed: () => void) {}

  private async init(): Promise<void> {
    this.initialized ??= (async () => {
      const saved = await this.secrets?.get(PIN)
      if (saved) {
        this.pin = JSON.parse(saved) as Pin
        this.rawKey = this.pin.key || ""
      }
    })()
    await this.initialized
  }
  private async revisions(): Promise<VaultRevision[]> {
    await this.init()
    const records = await this.store.readVault?.() ?? []
    if (!records.length && this.pin) throw new VaultStateError("error", "The synced vault is missing. Restore it from backup; local protection remains enabled.")
    return records
  }
  async enabled(): Promise<boolean> { return (await this.revisions()).length > 0 }

  async status(): Promise<AddonVaultStatus> {
    const protectedStorage = this.secrets?.protection === "os"
    if (!this.store.readVault || !this.store.writeVault || !this.secrets) return { state: "unavailable", message: "Secure addon sync is unavailable on this client", protectedStorage }
    try {
      const value = await this.read()
      return { state: value ? "ready" : "disabled", message: value ? "Ready · Encrypted sync enabled" : "Add-ons sync separately; tokens stay on this device", protectedStorage }
    } catch (error) {
      return { state: error instanceof VaultStateError ? error.state : "error", message: error instanceof Error ? error.message : "Could not read the vault", protectedStorage }
    }
  }

  private async decode(record: VaultRevision, checkHistory = true): Promise<{ envelope: VaultEnvelope; data: VaultData }> {
    const envelope = readEnvelope(record.value)
    if (this.pin && this.pin.id !== envelope.id) throw new VaultStateError("error", "A different vault was received. Use a separate Once profile to connect to another vault.")
    if (!this.rawKey) throw new VaultStateError("locked", "Unlock your synced add-ons and connections")
    const usedKey = this.rawKey
    const data = readVaultData(await decryptVault(envelope, usedKey))
    if (usedKey !== this.rawKey) throw new VaultStateError("locked", "The vault was locked while loading")
    if (checkHistory && this.pin && (data.generation < this.pin.generation ||
        (data.generation === this.pin.generation && data.commit !== this.pin.commit))) {
      throw new VaultStateError("conflict", "An older or concurrent vault version arrived. Review versions before continuing.")
    }
    return { envelope, data }
  }

  private async trust(envelope: VaultEnvelope, data: VaultData): Promise<void> {
    if (this.pin && data.generation < this.pin.generation) return
    if (this.pin?.generation === data.generation && this.pin.commit === data.commit) return
    const pin = { id: envelope.id, key: this.pin?.key ? this.rawKey : "", generation: data.generation,
      commit: data.commit, deviceName: this.pin?.deviceName || `Device ${randomHex(3)}` }
    await this.secrets?.set(PIN, JSON.stringify(pin))
    this.pin = pin
  }

  read(): Promise<VaultData | null> {
    return this.serialize(() => this.readNow())
  }

  private async readNow(): Promise<VaultData | null> {
    const records = await this.revisions()
    if (!records.length) return null
    if (records.length > 1) throw new VaultStateError("conflict", "Concurrent addon edits need review. Connections are paused until a version is chosen.")
    const { envelope, data } = await this.decode(records[0])
    await this.trust(envelope, data)
    return data
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(work)
    this.writes = pending.catch(() => undefined)
    return pending
  }

  async create(passphrase: string, remember: boolean, deviceName: string, data: VaultData): Promise<{ recoveryKey: string; warning?: string }> {
    return this.serialize(async () => {
      if (!this.store.writeVault || !this.secrets) throw new Error("Secure addon sync is unavailable")
      if ((await this.revisions()).length) throw new Error("A vault already exists. Unlock it instead.")
      const created = await createEnvelope(passphrase)
      data.generation = 1; data.commit = randomHex(16); data.author = this.deviceName(deviceName); data.updatedAt = new Date().toISOString()
      const encrypted = await encryptVault(created.envelope, created.rawKey, data)
      await this.store.writeVault(encrypted, [])
      this.rawKey = created.rawKey
      this.pin = { id: encrypted.id, key: remember ? this.rawKey : "", generation: 1, commit: data.commit, deviceName: data.author }
      let warning: string | undefined
      try { await this.secrets.set(PIN, JSON.stringify(this.pin)) }
      catch { warning = "Vault created, but its device key could not be saved. Save the recovery key now; you may need to unlock again after restarting." }
      this.changed()
      return { recoveryKey: created.recoveryKey, ...(warning ? { warning } : {}) }
    })
  }

  private deviceName(name: string): string { return name.trim().slice(0, 80) || this.pin?.deviceName || `Device ${randomHex(3)}` }

  async unlock(secret: string, recovery: boolean, remember: boolean, deviceName: string): Promise<void> {
    await this.serialize(async () => {
      const records = await this.revisions()
      if (!records.length) throw new Error("No synced vault has arrived yet")
      const envelope = readEnvelope(records[0].value)
      if (this.pin && this.pin.id !== envelope.id) throw new Error("This profile belongs to a different vault")
      const rawKey = await unlockEnvelope(envelope, secret, recovery)
      const data = readVaultData(await decryptVault(envelope, rawKey))
      const pin = { id: envelope.id, key: remember ? rawKey : "", generation: this.pin?.generation ?? data.generation,
        commit: this.pin?.commit ?? data.commit, deviceName: this.deviceName(deviceName) }
      await this.secrets?.set(PIN, JSON.stringify(pin))
      this.rawKey = rawKey
      this.pin = pin
      this.changed()
    })
  }

  async lock(): Promise<void> {
    await this.serialize(async () => {
      await this.init()
      this.rawKey = ""
      if (this.pin) { this.pin.key = ""; await this.secrets?.set(PIN, JSON.stringify(this.pin)) }
      this.changed()
    })
  }

  update(change: (data: VaultData) => Promise<void> | void, passphrase?: string): Promise<void> {
    return this.serialize(async () => {
      const records = await this.revisions()
      if (records.length !== 1) throw new Error("Unlock the vault and resolve concurrent edits before saving")
      const decoded = await this.decode(records[0])
      let envelope = decoded.envelope
      const data = decoded.data
      await change(data)
      if (passphrase !== undefined) envelope = await rewrapPassword(envelope, this.rawKey, passphrase)
      await this.commit(envelope, data, records.map(item => item.revision))
    })
  }

  private async commit(envelope: VaultEnvelope, data: VaultData, parents: string[]): Promise<void> {
    data.generation = Math.max(data.generation, this.pin?.generation ?? 0) + 1
    data.commit = randomHex(16); data.author = this.deviceName(""); data.updatedAt = new Date().toISOString()
    await this.store.writeVault?.(await encryptVault(envelope, this.rawKey, data), parents)
    await this.trust(envelope, data)
    this.changed()
  }

  async choices(): Promise<AddonVaultChoice[]> {
    const results: AddonVaultChoice[] = []
    for (const record of await this.revisions()) {
      const { data } = await this.decode(record, false)
      results.push({ revision: record.revision, author: data.author, updatedAt: data.updatedAt,
        addons: data.document.addons.map(item => `${item.manifest.name} ${item.manifest.version}`),
        connections: Object.keys(data.secrets).map(name => name.replace(/^addon:/, "")) })
    }
    return results
  }

  resolve(revision: string, expected: string[]): Promise<void> {
    return this.serialize(async () => {
      const records = await this.revisions()
      if ([...expected].sort().join(",") !== records.map(item => item.revision).sort().join(",")) throw new Error("Versions changed. Review them again.")
      const record = records.find(item => item.revision === revision)
      if (!record) throw new Error("That version is no longer available")
      const { envelope, data } = await this.decode(record, false)
      for (const branch of records) {
        const decoded = await this.decode(branch, false)
        data.generation = Math.max(data.generation, decoded.data.generation)
      }
      await this.commit(envelope, data, expected)
    })
  }
}
