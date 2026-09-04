import { TabEntry, WindowEntry } from "./BrowserState"

export interface TabHistorySnapshot {
  /** Shaped like Electron's NavigationEntry so it can be restored verbatim. */
  entries: { url: string, title: string }[]
  index: number
}

export interface ClosedTabRecord {
  url: string
  title: string
  /** The window webContents id the tab belonged to when it closed. */
  windowId: number
  /** Position in the owner's tab strip, so a reopened tab lands back in place. */
  index: number
  history: TabHistorySnapshot | null
}

const CLOSED_TAB_LIMIT = 25

/**
 * Recently closed tabs, newest last.
 *
 * A closed tab's webContents is already gone by the time TabOwnership finalizes
 * it, so the navigation history cannot be read there: TabEvents snapshots it on
 * every navigation instead, and this only stores what was captured.
 */
export class ClosedTabs {
  private readonly records: ClosedTabRecord[] = []

  record(entry: TabEntry, owner: WindowEntry, index: number): void {
    if (isThrowaway(entry)) return
    this.records.push({
      url: entry.displayedUrl,
      title: entry.title,
      windowId: owner.id,
      index,
      history: entry.historySnapshot ?? null
    })
    if (this.records.length > CLOSED_TAB_LIMIT) this.records.shift()
  }

  /** Newest tab from this window, else the newest from any window. */
  take(owner: WindowEntry): ClosedTabRecord | undefined {
    const windowId = owner.id
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      if (this.records[index].windowId !== windowId) continue
      return this.records.splice(index, 1)[0]
    }
    return this.records.pop()
  }

  get size(): number {
    return this.records.length
  }
}

/**
 * A blank tab that was never navigated. Recording those would make Ctrl+Shift+T
 * mostly resurrect empty tabs, since every window starts with one.
 */
function isThrowaway(entry: TabEntry): boolean {
  if (entry.displayedUrl && entry.displayedUrl !== "about:blank") return false
  return (entry.historySnapshot?.entries.length ?? 0) <= 1
}
