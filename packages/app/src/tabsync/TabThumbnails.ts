import type { SyncedTab, SyncedWindow } from "@once/core"
import type { TabSourcePort } from "../types"
import { TabDocRepository } from "./TabDocRepository"

/** New screenshots per publication: the selected tabs first, the rest over later ones. */
const CAPTURES_PER_PUBLICATION = 3

interface Cached { navSeq: number; url: string; thumb: NonNullable<SyncedTab["thumb"]> }

/**
 * Small screenshots of the published tabs. Each is taken once per page a tab
 * shows (its navigation and URL), stored under a name derived from its
 * content, and referenced from the publication; screenshots no publication
 * references any more are removed after a grace period.
 */
export class TabThumbnails {
  private readonly cache = new Map<string, Cached>()

  /** `graceMs`: how long an unreferenced screenshot stays, for devices still showing an older publication. */
  constructor(
    private readonly repository: TabDocRepository,
    private readonly source: TabSourcePort | undefined,
    private readonly graceMs: number
  ) {}

  /** The windows with screenshot references; `current` says whether the publication still counts. */
  async attach(deviceId: string, windows: SyncedWindow[], current: () => boolean): Promise<SyncedWindow[]> {
    const capture = this.source?.captureThumbnail?.bind(this.source)
    const open = new Set(windows.flatMap((window) => window.tabs.map((tab) => tab.id)))
    for (const id of this.cache.keys()) if (!open.has(id)) this.cache.delete(id)
    if (capture) {
      const wanted = windows.flatMap((window) => window.tabs)
        .filter((tab) => !this.fresh(tab))
        .sort((a, b) => Number(b.active) - Number(a.active))
        .slice(0, CAPTURES_PER_PUBLICATION)
      for (const tab of wanted) {
        if (!current()) return windows
        const shot = await capture(tab.id).catch(() => null)
        if (!shot || !current()) continue
        const id = await this.repository.putThumb(deviceId, shot.jpeg, shot.width, shot.height)
        this.cache.set(tab.id, { navSeq: tab.navSeq, url: tab.url, thumb: { id, w: shot.width, h: shot.height } })
      }
    }
    return windows.map((window) => ({
      ...window,
      tabs: window.tabs.map((tab) => {
        const cached = this.fresh(tab)
        return cached ? { ...tab, thumb: cached.thumb } : tab
      })
    }))
  }

  /** Removes this device's screenshots that the publication no longer references. */
  async collect(deviceId: string, windows: SyncedWindow[], now = Date.now()): Promise<void> {
    const referenced = new Set(windows.flatMap((window) => window.tabs.flatMap((tab) => tab.thumb ? [tab.thumb.id] : [])))
    await this.repository.deleteThumbs(deviceId, referenced, now - this.graceMs)
  }

  /** Screenshots were turned off or the identity changed: take new ones next time. */
  reset(): void {
    this.cache.clear()
  }

  private fresh(tab: SyncedTab): Cached | undefined {
    const cached = this.cache.get(tab.id)
    return cached && cached.navSeq === tab.navSeq && cached.url === tab.url ? cached : undefined
  }
}
