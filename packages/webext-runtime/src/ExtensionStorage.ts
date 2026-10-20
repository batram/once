import { utf8ByteLength } from "./bytes"
import { JsonStore } from "./hostServices"

export type StorageItems = Record<string, unknown>

export interface StorageChange {
  oldValue?: unknown
  newValue?: unknown
}

export type StorageChanges = Record<string, StorageChange>

const WRITE_DELAY_MS = 250

/**
 * `browser.storage.local` for one extension: a JSON document in the host's
 * store, loaded once and written back a moment after the last change.
 * uBlock keeps its settings here and its large caches in the background
 * page's own IndexedDB, so a single document is the right size for this.
 */
export class ExtensionStorage {
  private readonly listeners = new Set<() => void>()
  onChanged(listener: () => void): void { this.listeners.add(listener) }
  private changed(): void { for (const listener of this.listeners) listener() }
  private items: Map<string, unknown> | null = null
  private loading: Promise<Map<string, unknown>> | null = null
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()
  /** Keys changed since the last write; a store that patches gets only these. */
  private readonly dirty = new Set<string>()
  /** Until the document on disk is known (read or written whole), writes go whole. */
  private whole = true

  constructor(private readonly store: JsonStore, private readonly name: string) {}

  private async load(): Promise<Map<string, unknown>> {
    if (this.items) return this.items
    this.loading ??= (async () => {
      let entries: [string, unknown][] = []
      try {
        const parsed = await this.store.read(this.name)
        if (isRecord(parsed)) {
          entries = Object.entries(parsed)
          this.whole = false
        }
      } catch {
        // No store yet, or an unreadable one: start empty.
      }
      this.items = new Map(entries)
      return this.items
    })()
    return this.loading
  }

  /** Whether a loaded document has a key the predicate accepts; undefined before it is loaded. */
  someKey(predicate: (key: string) => boolean): boolean | undefined {
    if (!this.items) return undefined
    for (const key of this.items.keys()) if (predicate(key)) return true
    return false
  }

  async get(keys: unknown): Promise<StorageItems> {
    const items = await this.load()
    if (keys === null || keys === undefined) return Object.fromEntries(items)
    if (typeof keys === "string") {
      return items.has(keys) ? { [keys]: items.get(keys) } : {}
    }
    if (Array.isArray(keys)) {
      const result: StorageItems = {}
      for (const key of keys) {
        if (typeof key === "string" && items.has(key)) result[key] = items.get(key)
      }
      return result
    }
    if (isRecord(keys)) {
      const result: StorageItems = {}
      for (const [key, fallback] of Object.entries(keys)) {
        result[key] = items.has(key) ? items.get(key) : fallback
      }
      return result
    }
    throw new TypeError("storage.local.get: unsupported keys argument")
  }

  async set(values: unknown): Promise<StorageChanges> {
    if (!isRecord(values)) throw new TypeError("storage.local.set needs an object")
    const items = await this.load()
    const changes: StorageChanges = {}
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue
      if (JSON.stringify(items.get(key)) === JSON.stringify(value)) continue
      changes[key] = { oldValue: items.get(key), newValue: value }
      items.set(key, value)
      this.dirty.add(key)
    }
    if (Object.keys(changes).length) { this.scheduleWrite(); this.changed() }
    return changes
  }

  async remove(keys: unknown): Promise<StorageChanges> {
    const items = await this.load()
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : []
    const changes: StorageChanges = {}
    for (const key of list) {
      if (typeof key !== "string" || !items.has(key)) continue
      changes[key] = { oldValue: items.get(key) }
      items.delete(key)
      this.dirty.add(key)
    }
    if (Object.keys(changes).length) { this.scheduleWrite(); this.changed() }
    return changes
  }

  async clear(): Promise<StorageChanges> {
    const items = await this.load()
    const changes: StorageChanges = {}
    for (const [key, value] of items) {
      changes[key] = { oldValue: value }
      this.dirty.add(key)
    }
    items.clear()
    if (Object.keys(changes).length) { this.scheduleWrite(); this.changed() }
    return changes
  }

  async getBytesInUse(keys: unknown): Promise<number> {
    const subset = await this.get(keys ?? null)
    return utf8ByteLength(JSON.stringify(subset))
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.flush()
    }, WRITE_DELAY_MS)
  }

  /** Writes now; safe to await at quit. */
  flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    const items = this.items
    if (!items) return this.writing
    const patch = this.store.patch?.bind(this.store)
    if (patch && !this.whole) {
      if (this.dirty.size === 0) return this.writing
      const set: Record<string, unknown> = {}
      const remove: string[] = []
      for (const key of this.dirty) {
        if (items.has(key)) set[key] = items.get(key)
        else remove.push(key)
      }
      this.dirty.clear()
      this.writing = this.writing.then(() => patch(this.name, set, remove)).catch((error) => {
        // The document on disk is unknown now: the next write goes whole.
        this.whole = true
        console.error("Extension storage write failed", this.name, error)
      })
      return this.writing
    }
    const snapshot = Object.fromEntries(items)
    this.dirty.clear()
    this.whole = false
    this.writing = this.writing.then(() => this.store.write(this.name, snapshot)).catch((error) => {
      this.whole = true
      console.error("Extension storage write failed", this.name, error)
    })
    return this.writing
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
