import { AddonsDocument, AddonVaultChoice, AddonVaultStatus, mergeBundledOffers, VaultRevision } from "@once/core"
import type { ListStorePort, SecretStorePort } from "./types"
import { createEnvelope, decryptVault, encryptVault, randomHex, readEnvelope, rewrapPassword, unlockEnvelope, VaultEnvelope } from "./vaultCrypto"
import { canonical, readVaultData, sameVaultContents, VaultData } from "./vaultData"

const PIN = "once:addon-vault"
interface Pin { id: string; key: string; generation: number; commit: string; deviceName: string; left?: boolean }
class VaultStateError extends Error {
  constructor(readonly state: AddonVaultStatus["state"], message: string) { super(message) }
}

/**
 * What the versions disagree on, named for the reader: two versions of the
 * same add-on at the same version otherwise look identical in the review.
 * Token values are compared, never shown.
 */
function vaultDifferences(versions: VaultData[]): string[] {
  const facets = versions.map(data => {
    const facet = new Map<string, string>()
    for (const { manifest, enabled, options, storage } of data.document.addons) {
      facet.set(`${manifest.name}: package`, canonical(manifest))
      facet.set(`${manifest.name}: on or off`, String(enabled))
      facet.set(`${manifest.name}: settings`, canonical(options ?? {}))
      facet.set(`${manifest.name}: stored data`, canonical(storage ?? {}))
    }
    for (const [name, value] of Object.entries(data.secrets)) facet.set(`Token ${name.split(":").slice(1).join(":")}`, value)
    facet.set("Bundled add-on offers", canonical(data.document.bundled ?? {}))
    return facet
  })
  const names = [...new Set(facets.flatMap(facet => [...facet.keys()]))]
  return names.filter(name => new Set(facets.map(facet => facet.get(name))).size > 1)
}

/** The doc with these bundled offers, in the field order the reader produces (the vault rejects any other). */
function withOffers(doc: AddonsDocument, offers: Record<string, string> | undefined): AddonsDocument {
  const { bundled: _bundled, ...rest } = doc
  return offers ? { ...rest, bundled: offers } : rest
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
  /** Whether this device's add-ons live in the vault: one exists and this device has not left it. */
  async enabled(): Promise<boolean> { return (await this.revisions()).length > 0 && !this.pin?.left }

  /** This device turned add-on sync off for itself; the vault goes on for the others. */
  async left(): Promise<boolean> {
    await this.init()
    return this.pin?.left === true
  }

  async status(): Promise<AddonVaultStatus> {
    const protectedStorage = this.secrets?.protection === "os"
    if (!this.store.readVault || !this.store.writeVault || !this.secrets) return { state: "unavailable", message: "Secure addon sync is unavailable on this client", protectedStorage }
    if (await this.left()) return { state: "off", message: "Off on this device · other devices still sync", protectedStorage }
    try {
      const value = await this.read()
      return { state: value ? "ready" : "disabled", message: value ? "Ready · Encrypted sync enabled" : "Add-ons sync separately; tokens stay on this device", protectedStorage }
    } catch (error) {
      return { state: error instanceof VaultStateError ? error.state : "error", message: error instanceof Error ? error.message : "Could not read the vault", protectedStorage, unlockRequired: !this.rawKey }
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
    const pin: Pin = { id: envelope.id, key: this.pin?.key ? this.rawKey : "", generation: data.generation,
      commit: data.commit, deviceName: this.pin?.deviceName || `Device ${randomHex(3)}`, ...(this.pin?.left ? { left: true } : {}) }
    await this.secrets?.set(PIN, JSON.stringify(pin))
    this.pin = pin
  }

  read(): Promise<VaultData | null> {
    return this.serialize(() => this.readNow())
  }

  private async readNow(): Promise<VaultData | null> {
    const records = await this.revisions()
    if (!records.length) return null
    if (records.length > 1) {
      const settled = await this.settleConcurrent(records)
      if (!settled) throw new VaultStateError("conflict", "Concurrent add-on edits need review. Connections are paused until a version is chosen.")
      return settled
    }
    const { envelope, data } = await this.decode(records[0])
    await this.trust(envelope, data)
    return data
  }

  /**
   * Concurrent branches that need no choice. Two devices that make the same
   * change at once (both installing the same bundled package on their first
   * start, say) leave branches that differ only in who wrote them: keep the
   * winner every replica already agrees on and drop the rest, writing nothing
   * new. Branches that differ only in which bundled packages they recorded
   * offering combine those records, newest version first, in one new snapshot;
   * two devices combining at once write the same contents, which the next
   * read drops as duplicates. Anything else, a passphrase change, or branches
   * older than this device has seen, waits for review.
   */
  private async settleConcurrent(records: VaultRevision[]): Promise<VaultData | null> {
    if (!this.rawKey || !this.store.dropVaultBranches) return null
    try {
      const branches = await Promise.all(records.map(record => this.decode(record, false)))
      const [winner] = branches
      // A passphrase change rewraps the key without touching the contents; dropping it would undo it.
      const wrapping = ({ envelope }: { envelope: VaultEnvelope }) => [envelope.salt, envelope.password.iv, envelope.password.data, envelope.recovery.iv, envelope.recovery.data].join(".")
      if (branches.some(branch => wrapping(branch) !== wrapping(winner))) return null
      const generation = Math.max(...branches.map(branch => branch.data.generation))
      if (this.pin && generation < this.pin.generation) return null
      const offers = mergeBundledOffers(branches.map(branch => branch.data.document.bundled))
      const offered = (data: VaultData): VaultData => ({ ...data, document: withOffers(data.document, offers) })
      const merged = offered(winner.data)
      if (branches.some(branch => !sameVaultContents(merged, offered(branch.data)))) return null
      if (sameVaultContents(merged, winner.data) && (!this.pin || winner.data.generation >= this.pin.generation)) {
        await this.store.dropVaultBranches(records.slice(1).map(record => record.revision))
        await this.trust(winner.envelope, winner.data)
        this.changed()
        return winner.data
      }
      merged.generation = generation
      await this.commit(winner.envelope, merged, records.map(record => record.revision))
      return merged
    } catch (error) {
      if (error instanceof VaultStateError) throw error
      return null
    }
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

  /** Follows the shared device name, so later snapshots carry the current one. */
  async renameDevice(name: string): Promise<void> {
    await this.serialize(async () => {
      await this.init()
      if (!this.pin || !name.trim()) return
      this.pin = { ...this.pin, deviceName: name.trim().slice(0, 80) }
      await this.secrets?.set(PIN, JSON.stringify(this.pin))
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

  /** Whether `passphrase` opens the synced vault, without changing anything here. */
  async verifyPassphrase(passphrase: string): Promise<boolean> {
    const records = await this.revisions()
    if (!records.length) return false
    try {
      await unlockEnvelope(readEnvelope(records[0].value), passphrase, false)
      return true
    } catch {
      return false
    }
  }

  /**
   * Stops using the vault on this device only: forgets its key and marks the
   * device as having left, keeping the vault's identity so turning sync back
   * on unlocks the same vault. The shared vault is not touched.
   */
  async leave(): Promise<void> {
    await this.serialize(async () => {
      await this.init()
      if (!this.pin) throw new Error("Add-on sync is not set up on this device")
      this.rawKey = ""
      this.pin = { ...this.pin, key: "", left: true }
      await this.secrets?.set(PIN, JSON.stringify(this.pin))
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
      const before = JSON.stringify(data)
      await change(data)
      // Re-saving unchanged settings must not create another encrypted branch.
      if (passphrase === undefined && JSON.stringify(data) === before) { await this.trust(envelope, data); return }
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
    const branches: { record: VaultRevision; data: VaultData }[] = []
    for (const record of await this.revisions()) branches.push({ record, data: (await this.decode(record, false)).data })
    const differences = vaultDifferences(branches.map(branch => branch.data))
    return branches.map(({ record, data }) => ({ revision: record.revision, author: data.author, updatedAt: data.updatedAt,
      addons: data.document.addons.map(item => `${item.manifest.name} ${item.manifest.version}`),
      connections: Object.keys(data.secrets).map(name => name.replace(/^addon:/, "")), differences }))
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
