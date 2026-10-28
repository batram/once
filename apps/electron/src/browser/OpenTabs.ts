import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Rectangle } from "electron"
import type { TabEntry, WindowEntry } from "./BrowserState"
import { ClosedTabRecord, ClosedTabs, isClosedTabRecord, isThrowaway } from "./ClosedTabs"

/** One window of a session as it is written to disk and restored from it. */
export interface WindowSnapshot {
  id: number
  tabs: ClosedTabRecord[]
  activeIndex: number
  /** Where the window stood, when known; restored windows open there again. */
  bounds?: Rectangle
}

const SAVE_DELAY_MS = 1000

/**
 * The tabs currently open in every window, written to disk as they change.
 *
 * A window that closes while the app keeps running puts its tabs on the
 * reopen stack and is dropped from here. What is still on disk at the next
 * start is the previous session: the windows that were open when the app
 * quit, or when it crashed, was killed or lost power. The coordinator
 * restores those windows as they were, one window per snapshot with its tabs
 * and its position, the way Firefox and Chrome do, and only then does Reopen
 * closed tab reach the tabs closed before.
 */
export class OpenTabs {
  private readonly windows = new Map<number, WindowSnapshot>()
  private stale: WindowSnapshot[] = []
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
   * The windows of the previous session, in the order they were opened, each
   * with its tabs left to right. Taken once: a session that keeps crashing
   * while restoring must not restore the same windows forever.
   */
  takeSession(): WindowSnapshot[] {
    const stale = this.stale
    this.stale = []
    if (stale.length === 0) return []
    this.save()
    return stale
  }

  update(owner: WindowEntry, tabs: TabEntry[], bounds?: Rectangle): void {
    const kept = tabs.filter(tab => !isThrowaway(tab))
    const records = kept.map((tab, index) => ({
      url: tab.displayedUrl,
      title: tab.title,
      windowId: -1,
      index,
      history: tab.historySnapshot ?? null,
      extensionPage: tab.extensionPage
    }))
    const activeIndex = kept.findIndex(tab => tab.id === owner.activeId)
    const previous = this.windows.get(owner.id)
    this.windows.set(owner.id, {
      id: owner.id, tabs: records, activeIndex, bounds: bounds ?? previous?.bounds
    })
    this.scheduleSave()
  }

  /** A moved or resized window keeps its place in the snapshot without a tab change. */
  updateBounds(owner: WindowEntry, bounds: Rectangle): void {
    const snapshot = this.windows.get(owner.id)
    if (!snapshot) return
    snapshot.bounds = bounds
    this.scheduleSave()
  }

  forget(owner: WindowEntry): void {
    if (!this.windows.delete(owner.id)) return
    this.save()
  }

  /**
   * Writes what is pending right away. Called when the app is quitting: the
   * windows close from here on without being forgotten, and the file they
   * leave behind is the session the next start restores.
   */
  flush(): void {
    if (this.timer) this.save()
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

function isWindowSnapshot(value: unknown): value is WindowSnapshot {
  if (!value || typeof value !== "object") return false
  const window = value as WindowSnapshot
  if (window.bounds !== undefined && !isRectangle(window.bounds)) return false
  return Number.isInteger(window.id) && Number.isInteger(window.activeIndex)
    && Array.isArray(window.tabs) && window.tabs.every(isClosedTabRecord)
}

function isRectangle(value: unknown): value is Rectangle {
  if (!value || typeof value !== "object") return false
  const rect = value as Rectangle
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)
    && rect.width > 0 && rect.height > 0
}
