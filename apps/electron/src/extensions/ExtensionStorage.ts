import { promises as fs } from "node:fs"
import path from "node:path"

export type StorageItems = Record<string, unknown>

export interface StorageChange {
  oldValue?: unknown
  newValue?: unknown
}

export type StorageChanges = Record<string, StorageChange>

const WRITE_DELAY_MS = 250

/**
 * `browser.storage.local` for one extension: a JSON document on disk,
 * loaded once and written back a moment after the last change. uBlock keeps
 * its settings here and its large caches in the background page's own
 * IndexedDB, so a single file is the right size for this store.
 */
export class ExtensionStorage {
  private items: Map<string, unknown> | null = null
  private loading: Promise<Map<string, unknown>> | null = null
  private writeTimer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  private async load(): Promise<Map<string, unknown>> {
    if (this.items) return this.items
    this.loading ??= (async () => {
      let entries: [string, unknown][] = []
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(this.file, "utf8"))
        if (isRecord(parsed)) entries = Object.entries(parsed)
      } catch {
        // No store yet, or an unreadable one: start empty.
      }
      this.items = new Map(entries)
      return this.items
    })()
    return this.loading
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
      changes[key] = { oldValue: items.get(key), newValue: value }
      items.set(key, value)
    }
    this.scheduleWrite()
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
    }
    this.scheduleWrite()
    return changes
  }

  async clear(): Promise<StorageChanges> {
    const items = await this.load()
    const changes: StorageChanges = {}
    for (const [key, value] of items) changes[key] = { oldValue: value }
    items.clear()
    this.scheduleWrite()
    return changes
  }

  async getBytesInUse(keys: unknown): Promise<number> {
    const subset = await this.get(keys ?? null)
    return Buffer.byteLength(JSON.stringify(subset), "utf8")
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
    const snapshot = JSON.stringify(Object.fromEntries(items))
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      await fs.writeFile(temporary, snapshot, "utf8")
      await fs.rename(temporary, this.file)
    }).catch((error) => {
      console.error("Extension storage write failed", this.file, error)
    })
    return this.writing
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
