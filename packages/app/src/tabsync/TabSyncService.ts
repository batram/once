import {
  DeviceDoc,
  DEVICE_DOC_PREFIX,
  effectiveTabSyncOptions,
  readTabSyncSharedSettings,
  RetirementDoc,
  RETIREMENT_DOC_PREFIX,
  SendDoc,
  SEND_DOC_PREFIX,
  SyncedTab,
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
import { TabSyncMaintenance } from "./TabSyncMaintenance"
import { TabStates } from "./TabStates"
import { deviceDocument, publicationFingerprint, publishedWindows, visibleDevice } from "./tabPublication"

const TIMING = { debounce: 3000, minInterval: 15000, heartbeat: 10 * 60 * 1000, refresh: 250, thumbnailGrace: 60 * 60 * 1000, sample: 15000 }
const CHANNEL = "once-tabsync"

/** Publication timings an end-to-end test may shorten. */
export type TabSyncTestTiming = Partial<Pick<typeof TIMING, "debounce" | "minInterval">>

/**
 * Reads shorter publication timings handed in by an end-to-end test (a JSON
 * object, or its text). Only the debounce and the minimum interval, and only
 * values no longer than the real ones; anything else is ignored.
 */
export function tabSyncTestTiming(value: unknown): TabSyncTestTiming | undefined {
  let record: unknown = value
  if (typeof value === "string") {
    try { record = JSON.parse(value) } catch { return undefined }
  }
  if (!record || typeof record !== "object") return undefined
  const timing: TabSyncTestTiming = {}
  for (const key of ["debounce", "minInterval"] as const) {
    const number = (record as Record<string, unknown>)[key]
    if (typeof number === "number" && number >= 0 && number <= TIMING[key]) timing[key] = number
  }
  return Object.keys(timing).length ? timing : undefined
}

export interface RemoteDeviceView {
  deviceId: string
  name: string
  platform: TabSyncPlatform
  sharing: boolean
  sendTarget?: boolean
  updatedAt: string
  stale: boolean
  windows: DeviceDoc["windows"]
}

/** A tab another device sent here, waiting to be opened or dismissed. */
export interface SentTabView {
  id: string
  fromName: string
  url: string
  title: string
  mode: "web" | "reader"
  createdAt: string
  state?: SendDoc["state"]
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
  /** Tabs other devices sent here, newest first. */
  inbox: SentTabView[]
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
  /**
   * Whether a selected or playing tab has state worth sampling, for a
   * context whose timers do not survive sleep (an extension background
   * samples on alarms instead).
   */
  samplingNeeded?(needed: boolean): void
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
  private inbox: SendDoc[] = []
  private shared: TabSyncSharedSettings = { sendRetentionDays: 14 }
  private notice: string | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private generation = 0
  private publisher = false
  /** The settings the last reevaluation acted on. */
  private appliedSettings = ""
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
  private readonly states: TabStates
  private maintenanceTimer?: ReturnType<typeof setInterval>
  private disposed = false
  private readonly maintenance: TabSyncMaintenance
  private sampler?: ReturnType<typeof setInterval>
  private stopDeselected?: () => void
  /** The tabs of the last publication, to read a tab's state when it is left. */
  private lastTabs = new Map<string, SyncedTab>()

  constructor(private readonly deps: TabSyncDependencies) {
    this.timing = { ...TIMING, ...deps.timing }
    this.thumbnails = new TabThumbnails(deps.repository, deps.source)
    this.states = new TabStates(deps.source)
    this.maintenance = new TabSyncMaintenance(deps.repository, deps.identity,
      async () => !this.disposed && deps.syncActive() && (await this.activeOptions()).enabled, this.timing.thumbnailGrace)
  }

  async start(): Promise<void> {
    this.channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : undefined
    if (this.channel) {
      this.channel.onmessage = () => this.optionsChangedElsewhere()
    }
    this.disposers.push(this.deps.identity.onChanged(() => this.deps.changed()))
    await this.refresh()
    this.maintenanceTimer = setInterval(() => this.maintainSoon(), 10 * 60 * 1000)
    this.maintainSoon()
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
    this.disposed = true
    clearTimeout(this.refreshTimer)
    clearInterval(this.maintenanceTimer)
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
    else if (change.id.startsWith(DEVICE_DOC_PREFIX) || change.id.startsWith(RETIREMENT_DOC_PREFIX) ||
      change.id.startsWith(SEND_DOC_PREFIX)) this.scheduleRefresh()
  }

  /** Sync connected, disconnected or was blocked. */
  syncStateChanged(): void {
    void this.reevaluate()
  }

  /**
   * Another context (a panel, the background) changed the options or identity.
   * The store also reports this runtime's own writes, after the fact; those
   * change nothing here, and restarting for them would drop what was read
   * from tabs in between.
   */
  optionsChangedElsewhere(): void {
    this.deps.identity.invalidate()
    void this.settingsFingerprint().then((fingerprint) => this.reevaluate(fingerprint !== this.appliedSettings))
  }

  /** Rereads the other devices and this device's inbox, for a context without a change feed. */
  refreshSoon(): void {
    this.scheduleRefresh()
  }

  /** Independent from publishing, also called by extension alarms after worker sleep. */
  maintainSoon(): void {
    void this.maintenance.run(this.shared.sendRetentionDays).catch((error) => this.deps.reportError("tabsync.maintenance", error))
  }

  storage() { return this.maintenance.storage() }

  async cleanStorage(): Promise<void> {
    await this.maintenance.run(this.shared.sendRetentionDays, true)
    await this.refresh()
  }

  async removeInactive(ids: string[]): Promise<void> {
    const view = await this.view()
    for (const device of view.devices.filter((entry) => entry.stale && ids.includes(entry.deviceId))) {
      const latest = await this.deps.repository.resolveDevice(device.deviceId)
      if (latest && Date.now() - Date.parse(latest.updatedAt) > view.options.staleDeviceDays * 86400_000) {
        await this.forget(device.deviceId)
      }
    }
  }

  /** A heartbeat or retry: publish now, even if nothing changed. */
  publishSoon(): void {
    this.schedule(0, true)
  }

  /**
   * Reads the state of the selected and playing tabs, and publishes when it
   * changed: a video played on, an article scrolled. A tab held still is
   * not republished.
   */
  async sampleNow(): Promise<void> {
    if (!this.heartbeat || !this.deps.source) return
    const generation = this.generation
    const options = await this.activeOptions()
    if (!options.sharing) return
    const listed = publishedWindows(await this.deps.source.snapshot(), options)
    let changed = false
    for (const tab of this.states.sampled(listed)) {
      if (generation !== this.generation) return
      if (await this.states.capture(tab)) changed = true
    }
    this.deps.samplingNeeded?.(this.states.sampled(this.states.attach(listed)).some((tab) => tab.audible || tab.state))
    if (changed) this.schedule()
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
          deviceId: visible.deviceId, name: visible.name, platform: visible.platform, sharing: visible.sharing, sendTarget: visible.sendTarget !== false,
          updatedAt: visible.updatedAt, stale: Date.parse(visible.updatedAt) < staleBefore, windows: visible.windows
        }] : []
      })
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    // Off, this device lists nobody and nothing waits for it: every menu,
    // badge and notification built from the view goes quiet with it.
    const on = options.enabled
    return {
      available: true, canShare: Boolean(this.deps.source) || this.deps.sharesElsewhere === true,
      self: { deviceId: record.id, name: record.name, platform: this.deps.identity.platform },
      options, shared: this.shared, devices: on ? devices : [], notice: this.notice,
      inbox: (on && options.sendTarget ? this.inbox : []).map((send) => ({ id: send._id, fromName: send.fromName, url: send.url, title: send.title,
        mode: send.mode, createdAt: send.createdAt, ...(send.state ? { state: send.state } : {}) }))
    }
  }

  async setOptions(change: Partial<TabSyncOptions>): Promise<void> {
    const stored = await this.deps.identity.getOptions()
    const before = effectiveTabSyncOptions(stored)
    const after = effectiveTabSyncOptions({ ...stored, ...change })
    // Turning tab sync itself on counts too: it brings sharing or presence back.
    const turningOn = (after.sharing && !before.sharing) || (after.sendTarget && !before.sendTarget)
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
    this.maintainSoon()
  }

  async rename(name: string): Promise<void> {
    await this.deps.identity.rename(name)
    this.channel?.postMessage({ type: "identity" })
    this.lastFingerprint = ""
    this.schedule(0)
  }

  /** Sends a tab to another device, which lists it until it is opened or dismissed there. */
  async send(target: string, tab: Pick<SendDoc, "url" | "title" | "mode" | "state">): Promise<void> {
    const options = await this.activeOptions()
    if (!options.enabled) throw new Error("Tab sync is off on this device")
    const record = await this.deps.identity.get()
    const device = await this.deps.repository.resolveDevice(target)
    if (target === record.id || !device || device.sendTarget === false ||
      Date.now() - Date.parse(device.updatedAt) > options.staleDeviceDays * 86400_000 ||
      !visibleDevice(device, await this.deps.repository.readRetirement(target) ?? undefined)) {
      throw new Error("That device can no longer receive tabs")
    }
    if (!/^https?:\/\//i.test(tab.url)) throw new Error("Only web pages can be sent")
    await this.deps.repository.putSend(target, {
      from: record.id, fromName: record.name, url: tab.url, title: tab.title.slice(0, 512), mode: tab.mode,
      ...(tab.state ? { state: tab.state } : {}), createdAt: new Date().toISOString()
    })
  }

  /** Sends one of this device's tabs, with where it was left. */
  async sendLocal(target: string, tabId: string): Promise<void> {
    if (!this.deps.source) throw new Error("This device's tabs cannot be sent from here")
    const listed = publishedWindows(await this.deps.source.snapshot(), { ...await this.deps.identity.getOptions(), excludedDomains: [] })
    const tab = listed.flatMap((window) => window.tabs).find((item) => item.id === tabId)
    if (!tab) throw new Error("Only web pages can be sent")
    await this.states.capture(tab)
    const [withState] = this.states.attach([{ id: "", focused: false, tabs: [tab] }])
    await this.send(target, { url: tab.url, title: tab.title, mode: tab.mode, state: withState.tabs[0].state })
  }

  /** Takes a sent tab out of the inbox: opened or dismissed, it is gone on every device. */
  async takeSent(id: string): Promise<SentTabView | null> {
    if (!(await this.activeOptions()).sendTarget) return null
    const send = this.inbox.find((item) => item._id === id)
    if (!send) return null
    this.inbox = this.inbox.filter((item) => item !== send)
    this.deps.changed()
    await this.deps.repository.deleteSend(send)
    return { id: send._id, fromName: send.fromName, url: send.url, title: send.title, mode: send.mode, createdAt: send.createdAt,
      ...(send.state ? { state: send.state } : {}) }
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
    }, true)
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
  /** The options as they act: with tab sync off, nothing is shared or received. */
  private async activeOptions(): Promise<TabSyncOptions> {
    return effectiveTabSyncOptions(await this.deps.identity.getOptions())
  }

  /** What publishing depends on besides tabs: the options and who this device is. */
  private async settingsFingerprint(): Promise<string> {
    const [options, record] = await Promise.all([this.deps.identity.getOptions(), this.deps.identity.get()])
    return JSON.stringify([options, record.id, record.epoch, record.name])
  }

  private async reevaluate(restart = false): Promise<void> {
    this.appliedSettings = await this.settingsFingerprint()
    const options = await this.activeOptions()
    const wanted = this.publisher && this.deps.syncActive() && (options.sharing || options.sendTarget)
    if (restart || !wanted) {
      this.generation++
      this.stopPublishing()
      this.thumbnails.reset()
      this.states.reset()
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
      this.sampler = setInterval(() => void this.sampleNow(), this.timing.sample)
      // The tab being left is read before the reader is gone from it.
      this.stopDeselected = this.deps.source?.onDeselected?.((tabId) => void this.captureLeft(tabId))
      this.lastFingerprint = ""
    }
    this.schedule(0)
    this.deps.changed()
  }

  /** Reads the state of a tab just left; one opened since the last publication is looked up first. */
  private async captureLeft(tabId: string): Promise<void> {
    let tab = this.lastTabs.get(tabId)
    if (!tab && this.deps.source) {
      const options = await this.activeOptions()
      tab = publishedWindows(await this.deps.source.snapshot(), options)
        .flatMap((window) => window.tabs).find((item) => item.id === tabId)
    }
    if (tab && await this.states.capture(tab)) this.schedule()
  }

  private stopPublishing(): void {
    clearTimeout(this.debounce)
    clearInterval(this.heartbeat)
    clearInterval(this.sampler)
    this.stopDeselected?.()
    this.stopDeselected = undefined
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
    const options = await this.activeOptions()
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
    for (const tab of this.states.sampled(listed)) await this.states.capture(tab)
    this.lastTabs = new Map(listed.flatMap((window) => window.tabs.map((tab) => [tab.id, tab] as const)))
    this.states.prune(listed)
    const withState = this.states.attach(listed)
    if (generation !== this.generation) return
    const windows = options.sharing && options.screenshots
      ? await this.thumbnails.attach(record.id, withState, () => generation === this.generation)
      : withState
    if (generation !== this.generation) return
    const draft = deviceDocument({ deviceId: record.id, epoch: record.epoch, seq: record.seq, name: record.name,
      platform: this.deps.identity.platform, appVersion: this.deps.appVersion }, windows, options.sharing, Date.now(), options.sendTarget)
    const fingerprint = publicationFingerprint(draft)
    if (!force && fingerprint === this.lastFingerprint) return
    const { epoch, seq } = await this.deps.identity.nextSeq()
    if (generation !== this.generation) return
    const published = await this.deps.repository.publish({ ...draft, epoch, seq })
    this.lastFingerprint = fingerprint
    this.lastPublishedAt = Date.now()
    this.devices.set(published.deviceId, published)
    // Turning screenshots off withdraws them immediately. Routine collection is independent.
    if (!options.sharing || !options.screenshots) await this.deps.repository.deleteThumbs(record.id)
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
      // Only this device's own inbox, by its exact prefix.
      this.inbox = (await this.deps.repository.listSends(record.id))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      const own = this.retirements.get(record.id)
      if (this.publisher && own && own.retiredEpoch >= record.epoch && this.heartbeat) {
        await this.enqueue(() => this.retireSelf(own))
      }
    } catch (error) {
      this.deps.reportError("tabsync.refresh", error)
    }
    this.deps.changed()
  }

  private enqueue(work: () => Promise<void>, propagate = false): Promise<void> {
    const run = this.queue.then(work)
    const reported = run.catch((error) => this.deps.reportError("tabsync.publish", error))
    this.queue = reported
    return propagate ? run : reported
  }
}
