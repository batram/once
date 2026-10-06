/**
 * The records tab sync keeps in the shared sync database. Every kind has its
 * own id prefix so replication and the local observers can route it without
 * reading the body. See docs/plans/tab-sync-plan.md §2.
 */
export const DEVICE_DOC_PREFIX = "dev_"
export const THUMB_DOC_PREFIX = "tth_"
export const SEND_DOC_PREFIX = "tsend_"
export const RETIREMENT_DOC_PREFIX = "tret_"

/** The prefixes whose changes the runtime routes to tab sync; thumbnails are fetched on demand. */
export const ROUTED_TAB_DOC_PREFIXES = [DEVICE_DOC_PREFIX, SEND_DOC_PREFIX, RETIREMENT_DOC_PREFIX] as const

export type TabSyncPlatform = "electron" | "ios" | "android" | "firefox" | "chrome"
const PLATFORMS: readonly TabSyncPlatform[] = ["electron", "ios", "android", "firefox", "chrome"]

export interface TabStateEntry { v: number; capturedAt: string; data: unknown }

export interface SyncedTab {
  id: string
  /** Navigation generation of the local tab; state captured for an older one is stale. */
  navSeq: number
  url: string
  title: string
  mode: "web" | "reader"
  active: boolean
  pinned?: boolean
  audible?: boolean
  openedAt: string
  navigatedAt: string
  selectedAt: string
  activityAt: string
  storyId?: string
  thumb?: { id: string; w: number; h: number }
  /** Provider id → entry. Unknown providers are carried along untouched. */
  state?: Record<string, TabStateEntry>
}

export interface SyncedWindow { id: string; focused: boolean; tabs: SyncedTab[] }

export interface DeviceDoc {
  _id: string
  _rev?: string
  type: "device"
  schema: 1
  deviceId: string
  epoch: number
  /** Owner-issued, strictly increasing within an epoch; the only ordering used. */
  seq: number
  name: string
  platform: TabSyncPlatform
  appVersion: string
  /** False: a presence-only record that keeps the device available as a send target. */
  sharing: boolean
  /** Older publications without this field accept sends. */
  sendTarget?: boolean
  /** The owner's clock at publication; for display and freshness heuristics, never ordering. */
  updatedAt: string
  windows: SyncedWindow[]
}

export interface RetirementDoc {
  _id: string
  _rev?: string
  type: "retirement"
  deviceId: string
  retiredEpoch: number
  retiredAt: string
  retiredBy: string
}

export interface SendDoc {
  _id: string
  _rev?: string
  type: "send"
  from: string
  fromName: string
  url: string
  title: string
  mode: "web" | "reader"
  state?: Record<string, TabStateEntry>
  createdAt: string
}

const DEVICE_ID = /^[0-9a-f]{32}$/

export function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID.test(value)
}

export const deviceDocId = (deviceId: string): string => DEVICE_DOC_PREFIX + deviceId
export const retirementDocId = (deviceId: string): string => RETIREMENT_DOC_PREFIX + deviceId
export const sendDocPrefix = (targetDeviceId: string): string => `${SEND_DOC_PREFIX}${targetDeviceId}_`
export const thumbDocPrefix = (deviceId: string): string => `${THUMB_DOC_PREFIX}${deviceId}_`

export function isRoutedTabDocId(id: string): boolean {
  return ROUTED_TAB_DOC_PREFIXES.some((prefix) => id.startsWith(prefix))
}

/** Whether tab sync hears about a change: its routed records, and screenshots arriving after the publication naming them. */
export function isTabSyncChangeId(id: string): boolean {
  return isRoutedTabDocId(id) || id.startsWith(THUMB_DOC_PREFIX)
}

/** The target device of a send record id, or null when the id is not one. */
export function sendTarget(id: string): string | null {
  if (!id.startsWith(SEND_DOC_PREFIX)) return null
  const target = id.slice(SEND_DOC_PREFIX.length, SEND_DOC_PREFIX.length + 32)
  return isDeviceId(target) && id.charAt(SEND_DOC_PREFIX.length + 32) === "_" ? target : null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown, max = 2048): string => typeof value === "string" ? value.slice(0, max) : ""
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
const time = (value: unknown): string => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : ""

function readState(value: unknown): Record<string, TabStateEntry> | undefined {
  if (!isRecord(value)) return undefined
  const state: Record<string, TabStateEntry> = {}
  for (const [id, entry] of Object.entries(value)) {
    if (!isRecord(entry) || count(entry.v) === null || !time(entry.capturedAt)) continue
    Object.defineProperty(state, id, { enumerable: true, configurable: true, writable: true,
      value: { v: entry.v as number, capturedAt: entry.capturedAt as string, data: entry.data } })
  }
  return Object.keys(state).length ? state : undefined
}

function readTab(value: unknown): SyncedTab | null {
  if (!isRecord(value)) return null
  const navSeq = count(value.navSeq)
  const url = text(value.url, 8192)
  if (!text(value.id) || navSeq === null || !/^https?:\/\//i.test(url)) return null
  const tab: SyncedTab = {
    id: text(value.id), navSeq, url, title: text(value.title, 512),
    mode: value.mode === "reader" ? "reader" : "web",
    active: value.active === true,
    openedAt: time(value.openedAt), navigatedAt: time(value.navigatedAt),
    selectedAt: time(value.selectedAt), activityAt: time(value.activityAt)
  }
  if (value.pinned === true) tab.pinned = true
  if (value.audible === true) tab.audible = true
  if (text(value.storyId)) tab.storyId = text(value.storyId)
  const thumb = value.thumb
  if (isRecord(thumb) && text(thumb.id).startsWith(THUMB_DOC_PREFIX) && count(thumb.w) && count(thumb.h)) {
    tab.thumb = { id: text(thumb.id), w: thumb.w as number, h: thumb.h as number }
  }
  const state = readState(value.state)
  if (state) tab.state = state
  return tab
}

function readWindow(value: unknown): SyncedWindow | null {
  if (!isRecord(value) || !text(value.id) || !Array.isArray(value.tabs)) return null
  return {
    id: text(value.id), focused: value.focused === true,
    tabs: value.tabs.map(readTab).filter((tab): tab is SyncedTab => tab !== null)
  }
}

/** A device record as stored, or null when it is malformed or not a device record. */
export function readDeviceDoc(value: unknown): DeviceDoc | null {
  if (!isRecord(value) || value.type !== "device" || value.schema !== 1) return null
  const epoch = count(value.epoch), seq = count(value.seq)
  if (!isDeviceId(value.deviceId) || value._id !== deviceDocId(value.deviceId) || !epoch || seq === null) return null
  const platform = PLATFORMS.includes(value.platform as TabSyncPlatform) ? value.platform as TabSyncPlatform : null
  if (!platform || !time(value.updatedAt)) return null
  const sharing = value.sharing === true
  const doc: DeviceDoc = {
    _id: value._id, type: "device", schema: 1, deviceId: value.deviceId, epoch, seq,
    name: text(value.name, 80) || "Unnamed device", platform, appVersion: text(value.appVersion, 40),
    sharing, sendTarget: value.sendTarget !== false, updatedAt: value.updatedAt as string,
    windows: sharing && Array.isArray(value.windows)
      ? value.windows.map(readWindow).filter((entry): entry is SyncedWindow => entry !== null)
      : []
  }
  if (typeof value._rev === "string") doc._rev = value._rev
  return doc
}

export function readRetirementDoc(value: unknown): RetirementDoc | null {
  if (!isRecord(value) || value.type !== "retirement" || !isDeviceId(value.deviceId)) return null
  const retiredEpoch = count(value.retiredEpoch)
  if (value._id !== retirementDocId(value.deviceId) || !retiredEpoch || !time(value.retiredAt)) return null
  const doc: RetirementDoc = {
    _id: value._id, type: "retirement", deviceId: value.deviceId, retiredEpoch,
    retiredAt: value.retiredAt as string, retiredBy: text(value.retiredBy, 80)
  }
  if (typeof value._rev === "string") doc._rev = value._rev
  return doc
}

export function readSendDoc(value: unknown): SendDoc | null {
  if (!isRecord(value) || value.type !== "send" || typeof value._id !== "string") return null
  const url = text(value.url, 8192)
  if (!sendTarget(value._id) || !isDeviceId(value.from) || !/^https?:\/\//i.test(url) || !time(value.createdAt)) return null
  const doc: SendDoc = {
    _id: value._id, type: "send", from: value.from, fromName: text(value.fromName, 80), url,
    title: text(value.title, 512), mode: value.mode === "reader" ? "reader" : "web",
    createdAt: value.createdAt as string
  }
  const state = readState(value.state)
  if (state) doc.state = state
  if (typeof value._rev === "string") doc._rev = value._rev
  return doc
}

/**
 * Orders two publications of the same device: higher epoch, then higher
 * sequence, then the larger revision id so every device picks the same winner.
 */
export function comparePublications(
  a: Pick<DeviceDoc, "epoch" | "seq"> & { _rev?: string },
  b: Pick<DeviceDoc, "epoch" | "seq"> & { _rev?: string }
): number {
  return a.epoch - b.epoch || a.seq - b.seq || compareRevs(a._rev ?? "", b._rev ?? "")
}

function compareRevs(a: string, b: string): number {
  const depth = (rev: string) => Number.parseInt(rev, 10) || 0
  return depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0)
}

/** The revision that wins a device record conflict, from its readable leaves. */
export function winningPublication<T extends DeviceDoc>(leaves: T[]): T | null {
  return leaves.reduce<T | null>((best, leaf) => !best || comparePublications(leaf, best) > 0 ? leaf : best, null)
}

/** The retirement record that wins a conflict: the highest retired epoch. */
export function winningRetirement<T extends RetirementDoc>(leaves: T[]): T | null {
  return leaves.reduce<T | null>((best, leaf) =>
    !best || leaf.retiredEpoch > best.retiredEpoch ||
      (leaf.retiredEpoch === best.retiredEpoch && compareRevs(leaf._rev ?? "", best._rev ?? "") > 0)
      ? leaf : best, null)
}

/** Whether a retirement record hides this publication. Rejoining raises the epoch past it. */
export function isRetired(device: Pick<DeviceDoc, "epoch">, retirement: Pick<RetirementDoc, "retiredEpoch"> | null | undefined): boolean {
  return Boolean(retirement) && device.epoch <= (retirement as RetirementDoc).retiredEpoch
}
