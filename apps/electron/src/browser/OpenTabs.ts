import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { TabEntry, WindowEntry } from "./BrowserState"
import { ClosedTabRecord, ClosedTabs, isClosedTabRecord, isThrowaway } from "./ClosedTabs"

interface OpenWindowSnapshot {
  id: number
  tabs: ClosedTabRecord[]
  activeIndex: number
}

const SAVE_DELAY_MS = 1000

/**
 * The tabs currently open in every window, written to disk as they change.
 *
 * A window that closes normally puts its tabs on the reopen stack itself and
 * is dropped from here. Whatever is still on disk at the next start belonged
 * to a session that never got that far: a crash, a kill, a power cut. Those
 * tabs are what the user had open when the app went away, so they go on the
 * reopen stack ahead of everything closed before. Firefox and Chrome keep the
 * same kind of session store for the same reason; they just restore the whole
 * window at once, which Once leaves to Reopen closed tab, one tab at a time.
 */
export class OpenTabs {
  private readonly windows = new Map<number, OpenWindowSnapshot>()
  private stale: OpenWindowSnapshot[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly file?: string) {
    if (!file || !existsSync(file)) return
    try {
      const stored: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (!Array.isArray(stored)) throw new Error("Invalid open tab snapshot")
      this.stale = stored.filter(isWindowSnapshot)
    } catch (error) {
      console.warn("Could not load the open tab snapshot", error)
    }
  }

  /**
   * Tabs left open by a session that ended without closing its windows, in
   * reopen-stack order: newest last, so the active tab of the last window
   * comes back first, then that window's other tabs left to right.
   */
  takeStale(): ClosedTabRecord[] {
    const stale = this.stale
    this.stale = []
    if (stale.length === 0) return []
    this.save()
    return stale.flatMap(window => stackOrder(window.tabs, window.activeIndex))
  }

  update(owner: WindowEntry, tabs: TabEntry[]): void {
    const kept = tabs.filter(tab => !isThrowaway(tab))
    const records = kept.map((tab, index) => ({
      url: tab.displayedUrl,
      title: tab.title,
      windowId: -1,
      index,
      history: tab.historySnapshot ?? null
    }))
    const activeIndex = kept.findIndex(tab => tab.id === owner.activeId)
    this.windows.set(owner.id, { id: owner.id, tabs: records, activeIndex })
    this.scheduleSave()
  }

  forget(owner: WindowEntry): void {
    if (!this.windows.delete(owner.id)) return
    this.save()
  }

  private scheduleSave(): void {
    if (this.timer) return
    this.timer = setTimeout(() => this.save(), SAVE_DELAY_MS)
    this.timer.unref?.()
  }

  private save(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.file) return
    try {
      const snapshots = [...this.windows.values()].filter(window => window.tabs.length > 0)
      if (snapshots.length === 0) {
        rmSync(this.file, { force: true })
        return
      }
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify(snapshots), "utf8")
      renameSync(`${this.file}.tmp`, this.file)
    } catch (error) {
      console.warn("Could not save the open tab snapshot", error)
    }
  }
}

/** The closed and open tab stores of a profile directory, for TabOwnership. */
export function profileTabStores(directory: string): [ClosedTabs, OpenTabs] {
  return [
    new ClosedTabs(path.join(directory, "closed-tabs.json")),
    new OpenTabs(path.join(directory, "open-tabs.json"))
  ]
}

/**
 * Reopen-stack order for a window's tabs (newest last, so the last record
 * pops first): the active tab pops first, then the rest left to right.
 */
export function stackOrder(tabs: ClosedTabRecord[], activeIndex: number): ClosedTabRecord[] {
  const others = tabs.filter((_, index) => index !== activeIndex).reverse()
  const active = tabs[activeIndex]
  return active ? [...others, active] : others
}

function isWindowSnapshot(value: unknown): value is OpenWindowSnapshot {
  if (!value || typeof value !== "object") return false
  const window = value as OpenWindowSnapshot
  return Number.isInteger(window.id) && Number.isInteger(window.activeIndex)
    && Array.isArray(window.tabs) && window.tabs.every(isClosedTabRecord)
}
