import {
  DeviceDoc,
  DEVICE_DOC_PREFIX,
  readTabSyncSharedSettings,
  RetirementDoc,
  RETIREMENT_DOC_PREFIX,
  TAB_SYNC_SETTINGS_ID,
  THUMB_DOC_PREFIX,
  TabSyncOptions,
  TabSyncPlatform,
  TabSyncSharedSettings
} from "@once/core"
import type { DatabaseChange, ListStorePort, TabSourcePort } from "../types"
import { DeviceIdentity } from "./DeviceIdentity"
import { holdLock } from "./locks"
import { TabDocRepository } from "./TabDocRepository"
import { TabThumbnails } from "./TabThumbnails"
import { deviceDocument, expiredSends, publicationFingerprint, publishedWindows, visibleDevice } from "./tabPublication"

const TIMING = { debounce: 3000, minInterval: 15000, heartbeat: 10 * 60 * 1000, refresh: 250, thumbnailGrace: 60 * 60 * 1000 }
const CHANNEL = "once-tabsync"

export interface RemoteDeviceView {
  deviceId: string
  name: string
  platform: TabSyncPlatform
  sharing: boolean
  updatedAt: string
  stale: boolean
  windows: DeviceDoc["windows"]
}

export interface TabSyncView {
  /** False on a client without the storage tab sync needs. */
  available: boolean
  /** Whether this client can publish its own tabs (it has a tab source). */
  canShare: boolean
  self: { deviceId: string; name: string; platform: TabSyncPlatform } | null
  options: TabSyncOptions
  shared: TabSyncSharedSettings
  /** Other devices, newest first; this device and removed devices are left out. */
  devices: RemoteDeviceView[]
  /** Why this device stopped sharing, when another device removed it. */
  notice: string | null
}

export interface TabSyncDependencies {
  identity: DeviceIdentity
  repository: TabDocRepository
  listStore: ListStorePort
  source?: TabSourcePort
  /** Another context publishes this device's tabs (an extension's background). */
  sharesElsewhere?: boolean
  appVersion: string
  /** Whether sync is configured and allowed; nothing is published otherwise. */
  syncActive(): boolean
  changed(): void
  reportError(operation: string, error: unknown): void
  /** Shorter delays for tests. */
  timing?: Partial<typeof TIMING>
}

/**
 * Publishes this device's tabs and keeps the view of every other device's.
 * One runtime per device publishes (it holds the publisher lock); every
 * runtime reads. All writes go through one queue, and disabling bumps a
 * generation that drops work queued or in flight before it.
 */
export class TabSyncService {
  private devices = new Map<string, DeviceDoc>()
  private retirements = new Map<string, RetirementDoc>()
  private shared: TabSyncSharedSettings = { sendRetentionDays: 14 }
  private notice: string | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private generation = 0
  private publisher = false
  private releasePublisher?: () => void
  private debounce?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private refreshTimer?: ReturnType<typeof setTimeout>
  private lastPublishedAt = 0
  private lastFingerprint = ""
  private stopSource?: () => void
  private channel?: BroadcastChannel
  private readonly disposers: Array<() => void> = []
  private readonly timing: typeof TIMING
  private readonly thumbnails: TabThumbnails

  constructor(private readonly deps: TabSyncDependencies) {
    this.timing = { ...TIMING, ...deps.timing }
    this.thumbnails = new TabThumbnails(deps.repository, deps.source, this.timing.thumbnailGrace)
  }

  async start(): Promise<void> {
    this.channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : undefined
    if (this.channel) {
      this.channel.onmessage = () => this.optionsChangedElsewhere()
    }
    this.disposers.push(this.deps.identity.onChanged(() => this.deps.changed()))
    await this.refresh()
    if (this.deps.source) {
      this.releasePublisher = holdLock("once-tabsync-publisher", () => {
        this.publisher = true
        void this.reevaluate()
      })
    }
    if (typeof document !== "undefined") {
      const flush = () => { if (document.visibilityState === "hidden") this.schedule(0, true) }
      document.addEventListener("visibilitychange", flush)
      this.disposers.push(() => document.removeEventListener("visibilitychange", flush))
    }
  }

  dispose(): void {
    this.generation++
    this.stopPublishing()
    this.releasePublisher?.()
    this.channel?.close()
    this.disposers.forEach((dispose) => dispose())
  }

  /** Resolves once queued writes have settled; for tests and orderly shutdown. */
  async whenIdle(): Promise<void> {
    let queued: Promise<unknown>
    do {
      queued = this.queue
      await queued
    } while (queued !== this.queue)
  }

  /** A routed tab document changed, here, in another runtime, or by replication. */
  handleChange(change: DatabaseChange): void {
    if (change.id === "tabsync") this.scheduleRefresh()
    // A screenshot arrived after the publication naming it: views can show it now.
    else if (change.id.startsWith(THUMB_DOC_PREFIX)) this.deps.changed()
    else if (change.id.startsWith(DEVICE_DOC_PREFIX) || change.id.startsWith(RETIREMENT_DOC_PREFIX)) this.scheduleRefresh()
  }

  /** Sync connected, disconnected or was blocked. */
  syncStateChanged(): void {
    void this.reevaluate()
  }

  /** Another context (a panel, the background) changed the options or identity. */
  optionsChangedElsewhere(): void {
    this.deps.identity.invalidate()
    void this.reevaluate(true)
  }

  /** A heartbeat or retry: publish now, even if nothing changed. */
  publishSoon(): void {
    this.schedule(0, true)
  }

  /** Another device's tab screenshot as a data URL, or null while it has not arrived. */
  thumbnail(id: string): Promise<string | null> {
    return this.deps.repository.thumbnail(id)
  }

  async view(): Promise<TabSyncView> {
    const [record, options] = await Promise.all([this.deps.identity.get(), this.deps.identity.getOptions()])
    const staleBefore = Date.now() - options.staleDeviceDays * 24 * 60 * 60 * 1000
    const devices = [...this.devices.values()]
      .filter((device) => device.deviceId !== record.id)
      .flatMap((device) => {
        const visible = visibleDevice(device, this.retirements.get(device.deviceId))
        return visible ? [{
          deviceId: visible.deviceId, name: visible.name, platform: visible.platform, sharing: visible.sharing,
          updatedAt: visible.updatedAt, stale: Date.parse(visible.updatedAt) < staleBefore, windows: visible.windows
        }] : []
      })
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    return {
      available: true, canShare: Boolean(this.deps.source) || this.deps.sharesElsewhere === true,
      self: { deviceId: record.id, name: record.name, platform: this.deps.identity.platform },
      options, shared: this.shared, devices, notice: this.notice
    }
  }

  async setOptions(change: Partial<TabSyncOptions>): Promise<void> {
    const before = await this.deps.identity.getOptions()
    const turningOn = (change.sharing && !before.sharing) || (change.sendTarget && !before.sendTarget)
    if (turningOn) {
      // Turning sharing on again is how a removed device rejoins.
      const record = await this.deps.identity.get()
      const retirement = await this.deps.repository.readRetirement(record.id)
      if (retirement) await this.deps.identity.rejoin(retirement.retiredEpoch)
      this.notice = null
    }
    await this.deps.identity.setOptions(change)
    this.channel?.postMessage({ type: "options" })
    await this.reevaluate(true)
  }

  async rename(name: string): Promise<void> {
    await this.deps.identity.rename(name)
    this.channel?.postMessage({ type: "identity" })
    this.lastFingerprint = ""
    this.schedule(0)
  }

  async setShared(change: Partial<TabSyncSharedSettings>): Promise<void> {
    this.shared = readTabSyncSharedSettings({ ...this.shared, ...change })
    await this.deps.listStore.set(TAB_SYNC_SETTINGS_ID, this.shared)
    this.deps.changed()
  }

  /**
   * Removes another device from tab sync until it turns sharing on again:
   * a retained retirement record hides it even if it comes back online with
   * newer revisions, and tells it to stop publishing.
   */
  async forget(deviceId: string): Promise<void> {
    const record = await this.deps.identity.get()
    if (deviceId === record.id) throw new Error("Turn sharing off to remove this device")
    const device = this.devices.get(deviceId) ?? await this.deps.repository.resolveDevice(deviceId)
    await this.enqueue(async () => {
      await this.deps.repository.retire({
        deviceId, retiredEpoch: device?.epoch ?? 1, retiredAt: new Date().toISOString(), retiredBy: record.name
      })
      await this.deps.repository.deleteDevice(deviceId)
      await this.deps.repository.deleteThumbs(deviceId)
      for (const send of await this.deps.repository.listSends(deviceId)) await this.deps.repository.deleteSend(send)
    })
    await this.refresh()
  }

  /** A new identity for a copied profile; the old one is retired like a forgotten device. */
  async resetIdentity(): Promise<void> {
    this.generation++
    this.stopPublishing()
    const { previous } = await this.deps.identity.reset()
    this.channel?.postMessage({ type: "identity" })
    await this.enqueue(async () => {
      await this.deps.repository.retire({
        deviceId: previous.id, retiredEpoch: previous.epoch, retiredAt: new Date().toISOString(), retiredBy: previous.name
      })
      await this.deps.repository.deleteDevice(previous.id)
      await this.deps.repository.deleteThumbs(previous.id)
    })
    this.lastFingerprint = ""
    await this.reevaluate()
  }

  /**
   * Starts or stops publishing to match options, sync state and the publisher
   * lock. `restart` drops anything queued under the previous options, so a
   * capture still in flight cannot publish what was just turned off.
   */
  private async reevaluate(restart = false): Promise<void> {
    const options = await this.deps.identity.getOptions()
    const wanted = this.publisher && this.deps.syncActive() && (options.sharing || options.sendTarget)
    if (restart || !wanted) {
      this.generation++
      this.stopPublishing()
      this.thumbnails.reset()
    }
    if (!wanted) {
      // Only the publisher withdraws, after anything it queued before.
      if (this.publisher && this.deps.syncActive()) {
        const generation = this.generation
        void this.enqueue(() => this.withdraw(generation))
      }
      this.deps.changed()
      return
    }
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.schedule(0, true), this.timing.heartbeat)
      this.stopSource = this.deps.source?.onChanged(() => this.schedule())
      this.lastFingerprint = ""
    }
    this.schedule(0)
    this.deps.changed()
  }

  private stopPublishing(): void {
    clearTimeout(this.debounce)
    clearInterval(this.heartbeat)
    this.debounce = undefined
    this.heartbeat = undefined
    this.stopSource?.()
    this.stopSource = undefined
  }

  private schedule(delay = this.timing.debounce, force = false): void {
    if (!this.heartbeat) return
    if (this.debounce && !force) return
    clearTimeout(this.debounce)
    const wait = force ? delay : Math.max(delay, this.lastPublishedAt + this.timing.minInterval - Date.now())
    const generation = this.generation
    this.debounce = setTimeout(() => {
      this.debounce = undefined
      void this.enqueue(() => this.publish(generation, force))
    }, Math.max(0, wait))
  }

  private async publish(generation: number, force: boolean): Promise<void> {
    if (generation !== this.generation) return
    const options = await this.deps.identity.getOptions()
    const record = await this.deps.identity.get()
    const retirement = await this.deps.repository.readRetirement(record.id)
    if (retirement && retirement.retiredEpoch >= record.epoch) {
      await this.retireSelf(retirement)
      return
    }
    const listed = options.sharing && this.deps.source
      ? publishedWindows(await this.deps.source.snapshot(), options)
      : []
    if (generation !== this.generation) return
    const windows = options.sharing && options.screenshots
      ? await this.thumbnails.attach(record.id, listed, () => generation === this.generation)
      : listed
    if (generation !== this.generation) return
    const draft = deviceDocument({ deviceId: record.id, epoch: record.epoch, seq: record.seq, name: record.name,
      platform: this.deps.identity.platform, appVersion: this.deps.appVersion }, windows, options.sharing)
    const fingerprint = publicationFingerprint(draft)
    if (!force && fingerprint === this.lastFingerprint) return
    const { epoch, seq } = await this.deps.identity.nextSeq()
    if (generation !== this.generation) return
    const published = await this.deps.repository.publish({ ...draft, epoch, seq })
    this.lastFingerprint = fingerprint
    this.lastPublishedAt = Date.now()
    this.devices.set(published.deviceId, published)
    // Unreferenced screenshots go after a grace period; with screenshots off, at once.
    if (options.sharing && options.screenshots) await this.thumbnails.collect(record.id, windows)
    else await this.deps.repository.deleteThumbs(record.id)
    await this.collectGarbage()
  }

  private async retireSelf(retirement: RetirementDoc): Promise<void> {
    this.generation++
    this.stopPublishing()
    await this.deps.identity.setOptions({ sharing: false })
    const record = await this.deps.identity.get()
    await this.deps.repository.deleteDevice(record.id)
    await this.deps.repository.deleteThumbs(record.id)
    this.notice = `Removed from tab sync by ${retirement.retiredBy || "another device"}. Turn sharing on to rejoin.`
    this.deps.changed()
  }

  /** Withdraws everything this device published: it neither shares nor receives. */
  private async withdraw(generation: number): Promise<void> {
    if (generation !== this.generation) return
    const record = await this.deps.identity.get()
    if (await this.deps.repository.resolveDevice(record.id)) await this.deps.repository.deleteDevice(record.id)
    await this.deps.repository.deleteThumbs(record.id)
    this.lastFingerprint = ""
  }

  private async collectGarbage(): Promise<void> {
    const sends = await this.deps.repository.listSends()
    const expired = expiredSends(sends, this.devices, this.retirements, this.shared.sendRetentionDays)
    for (const send of expired) await this.deps.repository.deleteSend(send)
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => void this.refresh(), this.timing.refresh)
  }

  /** Reloads every device and retirement; reading a conflicted device resolves it. */
  private async refresh(): Promise<void> {
    try {
      const [devices, retirements, shared] = await Promise.all([
        this.deps.repository.listDevices(),
        this.deps.repository.listRetirements(),
        this.deps.listStore.get<unknown>(TAB_SYNC_SETTINGS_ID, null)
      ])
      this.devices = new Map(devices.map((device) => [device.deviceId, device]))
      this.retirements = new Map(retirements.map((record) => [record.deviceId, record]))
      this.shared = readTabSyncSharedSettings(shared)
      const record = await this.deps.identity.get()
      const own = this.retirements.get(record.id)
      if (this.publisher && own && own.retiredEpoch >= record.epoch && this.heartbeat) {
        await this.enqueue(() => this.retireSelf(own))
      }
    } catch (error) {
      this.deps.reportError("tabsync.refresh", error)
    }
    this.deps.changed()
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work).catch((error) => this.deps.reportError("tabsync.publish", error))
    this.queue = run
    return run
  }
}
