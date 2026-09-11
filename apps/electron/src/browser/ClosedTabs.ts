import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { TabEntry, WindowEntry } from "./BrowserState"

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

  constructor(private readonly file?: string) {
    if (!file || !existsSync(file)) return
    try {
      const stored: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (!Array.isArray(stored)) throw new Error("Invalid closed tab history")
      // One damaged record should not cost the other twenty-four.
      const valid = stored.filter(isClosedTabRecord)
      if (valid.length < stored.length) {
        console.warn(`Dropped ${stored.length - valid.length} invalid closed tab record(s)`)
      }
      // Electron webContents IDs only identify windows in the current process.
      this.records.push(...valid.slice(-CLOSED_TAB_LIMIT).map(record => ({
        ...record, windowId: -1
      })))
    } catch (error) {
      console.warn("Could not load closed tab history", error)
    }
  }

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
    this.save()
  }

  /** Newest tab from this window, else the newest from any window. */
  take(owner: WindowEntry): ClosedTabRecord | undefined {
    const windowId = owner.id
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      if (this.records[index].windowId !== windowId) continue
      const record = this.records.splice(index, 1)[0]
      this.save()
      return record
    }
    const record = this.records.pop()
    if (record) this.save()
    return record
  }

  get size(): number {
    return this.records.length
  }

  private save(): void {
    if (!this.file) return
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.records), "utf8")
      renameSync(`${this.file}.tmp`, this.file)
    } catch (error) {
      console.warn("Could not save closed tab history", error)
    }
  }
}

function isClosedTabRecord(value: unknown): value is ClosedTabRecord {
  if (!value || typeof value !== "object") return false
  const record = value as ClosedTabRecord
  if (typeof record.url !== "string" || typeof record.title !== "string"
    || !Number.isInteger(record.windowId)
    || !Number.isInteger(record.index) || record.index < 0) return false
  const history = record.history
  return history === null || (typeof history === "object" && history !== null
    && Array.isArray(history.entries) && history.entries.length > 0
    && Number.isInteger(history.index) && history.index >= 0
    && history.index < history.entries.length
    && history.entries.every(entry => entry && typeof entry.url === "string"
      && typeof entry.title === "string"))
}

/**
 * A blank tab that was never navigated. Recording those would make Reopen closed tab
 * mostly resurrect empty tabs, since every window starts with one.
 */
function isThrowaway(entry: TabEntry): boolean {
  if (entry.displayedUrl && entry.displayedUrl !== "about:blank") return false
  return (entry.historySnapshot?.entries.length ?? 0) <= 1
}
