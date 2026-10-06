/** The PouchDB calls tab sync uses; both pouchdb-browser and node pouchdb have them. */
export interface PouchTabDocsDatabase {
  get(id: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>
  put(doc: Record<string, unknown>): Promise<{ rev: string }>
  remove(id: string, rev: string): Promise<unknown>
  changes?(options: Record<string, unknown>): Promise<{ results: Array<{ deleted?: boolean }>; last_seq: unknown }>
  info?(): Promise<{ doc_count?: number; doc_del_count?: number }>
  allDocs(options: Record<string, unknown>): Promise<{ rows: Array<{ doc?: Record<string, unknown> | null }> }>
}

/**
 * Tab sync documents in the local database, which replication carries to the
 * others. A missing or deleted document reads as null; a revision that has
 * already gone, e.g. removed by another device's resolver, is not an error.
 */
export function pouchTabDocs(db: PouchTabDocsDatabase): {
  get(id: string, options?: { conflicts?: boolean; rev?: string; attachments?: boolean }): Promise<Record<string, unknown> | null>
  put(doc: Record<string, unknown>): Promise<{ rev: string }>
  remove(id: string, rev: string): Promise<void>
  info(): Promise<{ doc_count?: number; doc_del_count?: number }>
  page(prefix: string, after?: string, limit?: number): Promise<{ docs: Array<Record<string, unknown>>; next?: string }>
  list(prefix: string): Promise<Array<Record<string, unknown>>>
} {
  return {
    async info() {
      const info = await db.info?.() ?? {}
      if (!db.changes || info.doc_del_count !== undefined) return info
      let since: unknown = 0
      let deleted = 0
      for (;;) {
        const page = await db.changes({ since, limit: 1000, return_docs: true })
        deleted += page.results.filter((row) => row.deleted).length
        if (!page.results.length) break
        since = page.last_seq
      }
      return { ...info, doc_del_count: deleted }
    },
    async page(prefix, after, limit = 100) {
      const result = await db.allDocs({ startkey: after ? `${after}\u0000` : prefix, endkey: `${prefix}￿`,
        limit: limit + 1, include_docs: true, conflicts: true })
      const docs = result.rows.flatMap((row) => row.doc ? [row.doc] : [])
      const more = docs.length > limit
      docs.length = Math.min(docs.length, limit)
      return { docs, ...(more ? { next: String(docs[docs.length - 1]._id) } : {}) }
    },
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
