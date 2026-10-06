import {
  DeviceDoc,
  deviceDocId,
  isRetired,
  publishableUrl,
  RetirementDoc,
  SendDoc,
  sendTarget,
  SyncedTab,
  SyncedWindow,
  TabSyncOptions,
  TabSyncPlatform
} from "@once/core"
import type { LocalTab, LocalWindow } from "../types"

const iso = (time: number): string => new Date(Number.isFinite(time) && time > 0 ? time : Date.now()).toISOString()

/** What this device publishes of its windows: normal windows, http(s) tabs, no excluded domains. */
export function publishedWindows(windows: LocalWindow[], options: TabSyncOptions): SyncedWindow[] {
  return windows.flatMap((window) => {
    if (window.incognito) return []
    const tabs = window.tabs.flatMap((tab) => {
      const url = publishableUrl(tab.url, options.excludedDomains)
      return url ? [publishedTab(tab, url)] : []
    })
    return tabs.length ? [{ id: window.id, focused: window.focused, tabs }] : []
  })
}

function publishedTab(tab: LocalTab, url: string): SyncedTab {
  const published: SyncedTab = {
    id: tab.id, navSeq: tab.navSeq, url, title: tab.title.slice(0, 512), mode: tab.mode, active: tab.active,
    openedAt: iso(tab.openedAt), navigatedAt: iso(tab.navigatedAt),
    selectedAt: iso(tab.selectedAt), activityAt: iso(tab.activityAt)
  }
  if (tab.pinned) published.pinned = true
  if (tab.audible) published.audible = true
  if (tab.storyId) published.storyId = tab.storyId
  return published
}

export interface PublicationIdentity {
  deviceId: string
  epoch: number
  seq: number
  name: string
  platform: TabSyncPlatform
  appVersion: string
}

export function deviceDocument(identity: PublicationIdentity, windows: SyncedWindow[], sharing: boolean, now = Date.now()): Omit<DeviceDoc, "_rev"> {
  return {
    _id: deviceDocId(identity.deviceId), type: "device", schema: 1,
    deviceId: identity.deviceId, epoch: identity.epoch, seq: identity.seq,
    name: identity.name, platform: identity.platform, appVersion: identity.appVersion,
    sharing, updatedAt: new Date(now).toISOString(), windows: sharing ? windows : []
  }
}

/** A device the view lists, or null when it is retired. */
export function visibleDevice(device: DeviceDoc, retirement: RetirementDoc | undefined): DeviceDoc | null {
  return isRetired(device, retirement) ? null : device
}

/**
 * Sends that have outlived the shared retention, or whose target was removed
 * from tab sync and has not rejoined. Any device may delete them, which keeps
 * the retention a real bound when a target never returns.
 */
export function expiredSends(
  sends: SendDoc[],
  devices: ReadonlyMap<string, DeviceDoc>,
  retirements: ReadonlyMap<string, RetirementDoc>,
  retentionDays: number,
  now = Date.now()
): SendDoc[] {
  const limit = retentionDays * 24 * 60 * 60 * 1000
  return sends.filter((send) => {
    const target = sendTarget(send._id)
    if (!target) return false
    const retirement = retirements.get(target)
    const device = devices.get(target)
    const targetRetired = Boolean(retirement) && (!device || isRetired(device, retirement))
    return targetRetired || now - Date.parse(send.createdAt) > limit
  })
}

/** A stable fingerprint of what a publication says, to skip republishing nothing new. */
export function publicationFingerprint(doc: Pick<DeviceDoc, "name" | "sharing" | "windows" | "appVersion" | "epoch">): string {
  return JSON.stringify([doc.epoch, doc.name, doc.sharing, doc.appVersion, doc.windows])
}
