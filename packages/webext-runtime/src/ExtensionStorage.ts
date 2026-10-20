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
 * store, written back a moment after the last change. Hosts with keyed reads
 * and patches load only requested keys: extensions can mirror large caches
 * here even when their primary cache is IndexedDB.
 */
export class ExtensionStorage {
  private readonly listeners = new Set<() => void>()
  onChanged(listener: () => void): void { this.listeners.add(listener) }
  private changed(): void { for (const listener of this.listeners) listener() }
  private items: Map<string, unknown> | null = null
  private loading: Promise<void> = Promise.resolve()
  private complete = false
  private readonly known = new Set<string>()
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()
  /** Keys changed since the last write; a store that patches gets only these. */
  private readonly dirty = new Set<string>()
  /** Until the document on disk is known (read or written whole), writes go whole. */
  private whole = true

  constructor(private readonly store: JsonStore, private readonly name: string) {}

  private async load(keys: string[] | null = null): Promise<Map<string, unknown>> {
    const keyed = this.store.patch ? this.store.readKeys?.bind(this.store) : undefined
    const wanted = keyed ? keys : null
    if (this.complete || (wanted && wanted.every(key => this.known.has(key)))) return this.items ?? new Map()
    const loading = this.loading.then(async () => {
      if (this.complete) return
      const missing = wanted?.filter(key => !this.known.has(key)) ?? null
      if (missing?.length === 0) return
      let parsed: unknown
      if (missing && keyed) {
        // A failed partial read must not turn an existing key into a cached miss.
        parsed = await keyed(this.name, missing)
      } else {
        try { parsed = await this.store.read(this.name) } catch (error) {
          // Preserve the legacy whole-document recovery for hosts without keyed reads.
          if (keyed) throw error
        }
      }
      this.items ??= new Map()
      // Previously loaded values (including locally changed/deleted keys) win
      // over a later full read of the persisted document.
      if (isRecord(parsed)) for (const [key, value] of Object.entries(parsed)) {
        if (!this.known.has(key)) this.items.set(key, value)
      }
      if (missing) for (const key of missing) this.known.add(key)
      else this.complete = true
      if (keyed || isRecord(parsed)) this.whole = false
    })
    this.loading = loading.catch(() => undefined)
    await loading
    return this.items ?? new Map()
  }

  /** Whether a loaded document has a key the predicate accepts; undefined before it is loaded. */
  someKey(predicate: (key: string) => boolean): boolean | undefined {
    if (!this.items) return undefined
    for (const key of this.items.keys()) if (predicate(key)) return true
    return this.complete ? false : undefined
  }

  async get(keys: unknown): Promise<StorageItems> {
    const requested = keys === null || keys === undefined ? null
      : typeof keys === "string" ? [keys]
        : Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string")
          : isRecord(keys) ? Object.keys(keys) : null
    const items = await this.load(requested)
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
    const items = await this.load(Object.keys(values))
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
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : []
    const items = await this.load(list)
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
      const dirty = [...this.dirty]
      this.dirty.clear()
      this.writing = this.writing.then(() => patch(this.name, set, remove)).catch((error) => {
        // Retry current values on the next flush. A partial cache must never
        // replace the entire document after a failed patch.
        if (this.complete) this.whole = true
        else for (const key of dirty) this.dirty.add(key)
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
