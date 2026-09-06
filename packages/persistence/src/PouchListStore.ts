import { readVault, writeVault } from "./pouchVault"

export interface PouchListDatabase {
  get(id: string, options?: Record<string, unknown>): Promise<{ _rev?: string; _conflicts?: string[]; list?: unknown }>
  put(doc: Record<string, unknown>): Promise<unknown>
}

export class PouchListStore {
  constructor(private db: PouchListDatabase) {}

  readVault() { return readVault(this.db) }
  writeVault(value: unknown, parents: string[]): Promise<void> { return writeVault(this.db, value, parents) }

  async get<T>(id: string, fallbackValue: T): Promise<T> {
    try {
      const doc = await this.db.get(id)
      return doc.list as T
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        // Reading a default must not emit a settings change.
        return fallbackValue
      }
      throw err
    }
  }

  async set<T>(id: string, value: T): Promise<void> {
    const tryUpdate = async (retryCount = 0): Promise<void> => {
      try {
        const doc = await this.db.get(id)
        if (storedValuesEqual(doc.list, value)) return
        doc.list = value
        await this.db.put(doc as Record<string, unknown>)
      } catch (err) {
        const status = (err as { status?: number }).status
        if (status === 404) {
          await this.db.put({
            _id: id,
            list: value
          })
        } else if (status === 409 && retryCount < 3) {
          console.log(`Conflict on ${id}, retrying... (${retryCount + 1}/3)`)
          await tryUpdate(retryCount + 1)
        } else {
          console.error("pouch_set error:", err)
          throw err
        }
      }
    }

    await tryUpdate()
  }
}

function storedValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)])
  )
}
