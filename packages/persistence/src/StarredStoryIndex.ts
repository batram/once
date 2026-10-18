import type { PouchStoryDatabase } from "./PouchStoryStore"

const INDEX_ID = "_local/once-starred-index-v1"
const BATCH_SIZE = 500

/** A local, resumable projection of starred IDs, not a second copy of every story. */
export async function starredStoryDocuments(db: PouchStoryDatabase): Promise<Record<string, unknown>[]> {
  if (!db.changes) throw new Error("Starred-story projection requires a changes feed")
  const changes = db.changes.bind(db)
  for (let attempt = 0; ; attempt++) {
    try {
      const previous = await db.get(INDEX_ID).catch(error => {
        if (error.status === 404) return null
        throw error
      })
      const valid = previous?.version === 1 && previous.last_seq !== undefined &&
        Array.isArray(previous.ids) && previous.ids.every(id => typeof id === "string" && id.startsWith("sto_"))
      const ids = new Set<string>(valid ? previous.ids as string[] : [])
      const initial = valid ? previous.last_seq : 0
      let since = initial
      for (;;) {
        const page = await changes({ since, limit: BATCH_SIZE, batch_size: BATCH_SIZE, include_docs: true, return_docs: true })
        if (!page.results.length) break
        for (const row of page.results) {
          if (!row.id.startsWith("sto_")) continue
          if (!row.deleted && !row.doc) throw new Error("Starred-story index received an incomplete change")
          if (!row.deleted && !row.doc?._deleted && row.doc?.stared === true) ids.add(row.id)
          else ids.delete(row.id)
        }
        since = page.last_seq
      }
      const sorted = [...ids].sort()
      if (!valid || JSON.stringify(since) !== JSON.stringify(initial)) {
        await db.put({ _id: INDEX_ID, ...(previous ? { _rev: previous._rev } : {}), version: 1, last_seq: since, ids: sorted })
      }
      const docs: Record<string, unknown>[] = []
      for (let offset = 0; offset < sorted.length; offset += BATCH_SIZE) {
        const result = await db.allDocs({ keys: sorted.slice(offset, offset + BATCH_SIZE), include_docs: true })
        for (const row of result.rows) {
          const doc = row.doc as Record<string, unknown> | undefined
          // A concurrent unstar/delete can happen after the changes snapshot.
          if (doc?.stared === true && !doc._deleted) docs.push(doc)
        }
      }
      return docs
    } catch (error) {
      // Another window may advance the projection. Re-read its checkpoint;
      // never overwrite it with an older ID set after a compare-and-swap fails.
      if ((error as { status?: number }).status !== 409 || attempt >= 2) throw error
    }
  }
}
