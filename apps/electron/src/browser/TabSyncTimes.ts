import { ELECTRON_IPC, ElectronSyncWindow } from "@once/platform-electron/bridge"
import type { TabEntry, WindowEntry } from "./BrowserState"
import type { TabOwnership } from "./TabOwnership"
import { isReadableUrl, sourceUrlFromReaderUrl } from "./reader-url"
import { captureTab } from "./tabCapture"

/**
 * When a tab was opened, navigated, selected and last used, and which
 * navigation it is on. Tab sync publishes these; state captured for an older
 * navigation is stale.
 */
export interface TabSyncTimes {
  navSeq: number
  openedAt: number
  navigatedAt: number
  selectedAt: number
  activityAt: number
}

export function newTabSyncTimes(now = Date.now()): TabSyncTimes {
  return { navSeq: 0, openedAt: now, navigatedAt: now, selectedAt: now, activityAt: now }
}

export function markNavigated(entry: TabEntry, now = Date.now()): void {
  entry.sync.navSeq++
  entry.sync.navigatedAt = now
  entry.sync.activityAt = now
}

export function markSelected(entry: TabEntry, now = Date.now()): void {
  entry.sync.selectedAt = now
  entry.sync.activityAt = now
}

export function markActivity(entry: TabEntry, now = Date.now()): void {
  entry.sync.activityAt = now
}

/**
 * Every window's tabs as tab sync reads them. A reader view is its source
 * page in reader mode; anything that is not a web page is left for the
 * publisher's filter to drop.
 */
export function tabSyncSnapshot(
  windows: Iterable<WindowEntry>,
  tab: (id: string) => TabEntry | undefined
): ElectronSyncWindow[] {
  return [...windows].flatMap((owner) => {
    if (owner.closing || owner.window.isDestroyed()) return []
    const tabs = owner.tabs.flatMap((id) => {
      const entry = tab(id)
      if (!entry || entry.extensionPage) return []
      const source = sourceUrlFromReaderUrl(entry.displayedUrl)
      const url = source ?? entry.displayedUrl
      if (!isReadableUrl(url)) return []
      return [{
        id, url, title: entry.title, mode: source ? "reader" as const : "web" as const,
        active: owner.activeId === id, audible: entry.audible, ...entry.sync
      }]
    })
    return [{ id: String(owner.id), focused: owner.window.isFocused(), tabs }]
  })
}

export interface TabSyncFeed {
  snapshot(): ElectronSyncWindow[]
  /** A small screenshot for other devices, once the tab has finished loading. */
  capture(tabId: string): Promise<{ jpeg: string; width: number; height: number } | null>
  /** Starts telling every shell when some window's tabs change. */
  observe(): () => void
}

/**
 * Every window's tabs for tab sync, which publishes them all from one window,
 * and change notices to every shell at most every half second: tab sync
 * debounces anyway, and a page load changes a tab often.
 */
export function tabSyncFeed(ownership: TabOwnership): TabSyncFeed {
  return {
    snapshot: () => tabSyncSnapshot(ownership.windows.values(), (id) => ownership.get(id)),
    async capture(tabId) {
      const entry = ownership.get(tabId)
      const contents = entry?.view.webContents
      if (!entry || entry.loading || entry.loadError || !contents || contents.isDestroyed()) return null
      return captureTab(contents, 320, 60)
    },
    observe() {
      let timer: ReturnType<typeof setTimeout> | undefined
      const stop = ownership.observe(() => {
        timer ??= setTimeout(() => {
          timer = undefined
          for (const owner of ownership.windows.values()) {
            if (!owner.window.isDestroyed()) owner.window.webContents.send(ELECTRON_IPC.tabSyncChanged)
          }
        }, 500)
      })
      return () => {
        clearTimeout(timer)
        stop()
      }
    }
  }
}
