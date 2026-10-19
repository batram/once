import type { EpochCopyDatabase } from "./PouchEpochCopy"

const queues = new Map<string, Promise<unknown>>()
const guarded = new WeakSet<object>()
const originalWrites = new WeakMap<object, EpochCopyDatabase["bulkDocs"]>()

/** Ordinary local writes and the final migration phase use the same cross-context lock. */
export function epochLock<T>(base: string, work: () => Promise<T>): Promise<T> {
  const name = `once-local-database-epoch:${base}`
  if (globalThis.navigator?.locks) return navigator.locks.request(name, work)
  // Node fixtures have one context. A browser without Web Locks cannot
  // safely migrate while another window may be writing.
  const run = (queues.get(name) ?? Promise.resolve()).then(work, work)
  queues.set(name, run.catch(() => undefined))
  return run
}

/** Pouch's local idb/leveldb put, remove, attachments and replication all enter bulkDocs. */
export function guardEpochWrites(base: string, db: EpochCopyDatabase): void {
  if (guarded.has(db) || !db.bulkDocs) return
  guarded.add(db)
  const bulkDocs = db.bulkDocs.bind(db)
  originalWrites.set(db, bulkDocs)
  type Callback = (error: unknown, result?: unknown) => void
  const wrapper = (request: Record<string, unknown>[] | { docs: Record<string, unknown>[] }, options?: Record<string, unknown> | Callback, callback?: Callback) => {
    const docs = Array.isArray(request) ? request : request.docs
    const done = typeof options === "function" ? options : callback
    const operation = () => bulkDocs(request as Record<string, unknown>[], typeof options === "function" ? undefined : options)
    const run = docs.every(doc => String(doc._id).startsWith("_local/")) ? operation() : epochLock(base, async () => {
      const state = await db.get("_local/once-sync-epoch").catch(error => {
        if (error.status === 404) return null
        throw error
      })
      if (state?.retired) throw new Error("This local database is retired. Reload Once to continue; the write was not saved.")
      return operation()
    })
    if (done) void run.then(result => done(null, result), error => done(error))
    return run
  }
  db.bulkDocs = wrapper as EpochCopyDatabase["bulkDocs"]
}

/** Explicit multi-step setting resolution holds the lock once, including its writes. */
export function withEpochDocumentWrites<T>(base: string, db: EpochCopyDatabase,
  work: (direct: Pick<EpochCopyDatabase, "get" | "put" | "bulkDocs">) => Promise<T>): Promise<T> {
  return epochLock(base, async () => {
    const bulkDocs = originalWrites.get(db) ?? db.bulkDocs.bind(db)
    return work({
      get: db.get.bind(db), bulkDocs,
      async put(doc) {
        const [result] = await bulkDocs([doc]) as Array<{ rev?: string; error?: string; reason?: string; status?: number }>
        if (!result || result.error) throw Object.assign(new Error(result?.reason ?? "Setting write failed"), { status: result?.status })
        return { rev: result.rev }
      }
    })
  })
}
