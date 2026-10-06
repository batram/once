/** The PouchDB calls tab sync uses; both pouchdb-browser and node pouchdb have them. */
export interface PouchTabDocsDatabase {
  get(id: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>
  put(doc: Record<string, unknown>): Promise<{ rev: string }>
  remove(id: string, rev: string): Promise<unknown>
  allDocs(options: Record<string, unknown>): Promise<{ rows: Array<{ doc?: Record<string, unknown> | null }> }>
}

/**
 * Tab sync documents in the local database, which replication carries to the
 * others. A missing or deleted document reads as null; a revision that has
 * already gone, e.g. removed by another device's resolver, is not an error.
 */
export function pouchTabDocs(db: PouchTabDocsDatabase): {
  get(id: string, options?: { conflicts?: boolean; rev?: string }): Promise<Record<string, unknown> | null>
  put(doc: Record<string, unknown>): Promise<{ rev: string }>
  remove(id: string, rev: string): Promise<void>
  list(prefix: string): Promise<Array<Record<string, unknown>>>
} {
  return {
    async get(id, options = {}) {
      try {
        return await db.get(id, options)
      } catch (error) {
        if (status(error) === 404) return null
        throw error
      }
    },
    put: (doc) => db.put(doc),
    async remove(id, rev) {
      try {
        await db.remove(id, rev)
      } catch (error) {
        if (status(error) !== 404 && status(error) !== 409) throw error
      }
    },
    async list(prefix) {
      const result = await db.allDocs({
        startkey: prefix,
        endkey: `${prefix}￿`,
        include_docs: true,
        conflicts: true
      })
      return result.rows.flatMap((row) => row.doc ? [row.doc] : [])
    }
  }
}

function status(error: unknown): unknown {
  return error && typeof error === "object" ? (error as { status?: unknown }).status : undefined
}
