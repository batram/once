import { DEFAULT_TAB_SYNC_OPTIONS, isDeviceId, readTabSyncOptions, TabSyncOptions, TabSyncPlatform } from "@once/core"
import type { SecretStorePort } from "../types"
import { withLock } from "./locks"

const IDENTITY_KEY = "once:device-identity"
const OPTIONS_KEY = "once:tabsync-options"
const VAULT_PIN_KEY = "once:addon-vault"

/**
 * Who this installation is to the other devices. Kept in device-local storage
 * (never browser-synced storage), so two machines signed into one browser
 * profile are two devices. A copied profile copies this too; "Reset device
 * identity" is the remedy, not detection.
 */
export interface DeviceIdentityRecord {
  id: string
  epoch: number
  /** The last publication sequence issued in this epoch. */
  seq: number
  name: string
}

export class DeviceIdentity {
  private record?: Promise<DeviceIdentityRecord>
  private options?: Promise<TabSyncOptions>
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly secrets: SecretStorePort,
    readonly platform: TabSyncPlatform,
    private readonly defaultName: string
  ) {}

  /** Get-or-create under a lock, so simultaneous startups cannot mint two ids. */
  get(): Promise<DeviceIdentityRecord> {
    this.record ??= withLock("once-device-identity", () => this.loadOrCreate())
    this.record.catch(() => { this.record = undefined })
    return this.record
  }

  async rename(name: string): Promise<DeviceIdentityRecord> {
    const trimmed = name.trim().slice(0, 80)
    if (!trimmed) throw new Error("Give this device a name")
    return this.update((record) => ({ ...record, name: trimmed }))
  }

  /** The next publication sequence, persisted before it is used. */
  async nextSeq(): Promise<{ epoch: number; seq: number }> {
    const record = await this.update((current) => ({ ...current, seq: current.seq + 1 }))
    return { epoch: record.epoch, seq: record.seq }
  }

  /** Rejoining after a retirement: an epoch the retirement record does not cover. */
  async rejoin(retiredEpoch: number): Promise<DeviceIdentityRecord> {
    return this.update((record) => record.epoch > retiredEpoch ? record : { ...record, epoch: retiredEpoch + 1, seq: 0 })
  }

  /** A new id for this installation; the caller retires the old one. */
  async reset(): Promise<{ previous: DeviceIdentityRecord; current: DeviceIdentityRecord }> {
    let previous: DeviceIdentityRecord | undefined
    const current = await this.update((record) => {
      previous = record
      return { id: randomId(), epoch: 1, seq: 0, name: record.name }
    })
    return { previous: previous as DeviceIdentityRecord, current }
  }

  getOptions(): Promise<TabSyncOptions> {
    this.options ??= this.secrets.get(OPTIONS_KEY).then((saved) => {
      try { return readTabSyncOptions(saved ? JSON.parse(saved) : {}) } catch { return { ...DEFAULT_TAB_SYNC_OPTIONS } }
    })
    this.options.catch(() => { this.options = undefined })
    return this.options
  }

  async setOptions(change: Partial<TabSyncOptions>): Promise<TabSyncOptions> {
    const next = readTabSyncOptions({ ...await this.getOptions(), ...change })
    await this.secrets.set(OPTIONS_KEY, JSON.stringify(next))
    this.options = Promise.resolve(next)
    this.listeners.forEach((listener) => listener())
    return next
  }

  /** Another window, panel or the background changed the stored options or identity. */
  invalidate(): void {
    this.record = undefined
    this.options = undefined
    this.listeners.forEach((listener) => listener())
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(change: (record: DeviceIdentityRecord) => DeviceIdentityRecord): Promise<DeviceIdentityRecord> {
    const work = withLock("once-device-identity", async () => {
      const current = await this.loadOrCreate()
      const next = change(current)
      await this.secrets.set(IDENTITY_KEY, JSON.stringify(next))
      return next
    })
    this.record = work
    work.then(() => this.listeners.forEach((listener) => listener()), () => { this.record = undefined })
    return work
  }

  /** Only while holding the identity lock. */
  private async loadOrCreate(): Promise<DeviceIdentityRecord> {
    const saved = parseRecord(await this.secrets.get(IDENTITY_KEY))
    if (saved) return saved
    const created: DeviceIdentityRecord = { id: randomId(), epoch: 1, seq: 0, name: await this.migratedName() }
    await this.secrets.set(IDENTITY_KEY, JSON.stringify(created))
    return created
  }

  /** The add-on vault already asked for a device name; adopt it instead of asking again. */
  private async migratedName(): Promise<string> {
    try {
      const pin = JSON.parse(await this.secrets.get(VAULT_PIN_KEY) || "{}") as { deviceName?: unknown }
      if (typeof pin.deviceName === "string" && pin.deviceName.trim()) return pin.deviceName.trim().slice(0, 80)
    } catch {
      // An unreadable pin is the vault's to report; fall back to the platform name.
    }
    return this.defaultName
  }
}

function parseRecord(value: string): DeviceIdentityRecord | null {
  if (!value) return null
  try {
    const record = JSON.parse(value) as Partial<DeviceIdentityRecord>
    const valid = isDeviceId(record.id) && Number.isSafeInteger(record.epoch) && (record.epoch as number) > 0 &&
      Number.isSafeInteger(record.seq) && (record.seq as number) >= 0 && typeof record.name === "string"
    return valid ? record as DeviceIdentityRecord : null
  } catch {
    return null
  }
}

function randomId(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}
