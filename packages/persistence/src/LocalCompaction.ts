import type { PouchMaintenanceDatabase } from "./PouchMaintenanceService"

type RevisionNode = [string, { status?: string }, RevisionNode[]]
export interface LocalCompactionDatabase {
  /** Local PouchDB adapter metadata API; never writes a revision tree directly. */
  _getRevisionTree?(id: string, callback: (error: unknown, tree?: Array<{ ids: RevisionNode }>) => void): void
  compactDocument?(id: string, maxHeight: number): Promise<unknown>
}

const CHECKPOINT = "_local/once-compaction-progress-v1"
const BATCH_SIZE = 500
const CONCURRENCY = 8

/** Compact only bodies that can actually be reclaimed, with a bounded adapter queue. */
export async function compactLocalRevisions(db: PouchMaintenanceDatabase, current: () => boolean,
  progress: (checked: number, compacted: number) => void): Promise<boolean> {
  if (!current()) return false
  // Other adapters/fixtures retain their public compaction implementation.
  if (!db._getRevisionTree || !db.compactDocument || !db.changes || !db.get || !db.put) {
    await db.compact?.()
    return current()
  }
  const readTree = db._getRevisionTree.bind(db), compactDocument = db.compactDocument.bind(db)
  let checkpoint = await db.get(CHECKPOINT).catch(error => {
    if (error.status === 404) return null
    throw error
  })
  let since: unknown = checkpoint?.last_seq ?? 0
  let checked = 0, compacted = 0
  const hasRemovableBody = (node: RevisionNode): boolean =>
    (node[2].length > 0 && node[1].status === "available") || node[2].some(hasRemovableBody)
  while (current()) {
    const page = await db.changes({ since, limit: BATCH_SIZE, batch_size: BATCH_SIZE, return_docs: true })
    if (!page.results.length) return current()
    let cursor = 0
    let failed = false
    // Settle every worker before returning an error: never leave compactions
    // running after the caller starts a different maintenance generation.
    const workers = await Promise.allSettled(Array.from({ length: CONCURRENCY }, async () => {
      try { while (current() && !failed && cursor < page.results.length) {
        const row = page.results[cursor++]
        const id = row.id
        if (!id) throw new Error("Compaction change omitted its document ID")
        const tree = await new Promise<Array<{ ids: RevisionNode }>>((resolve, reject) => {
          readTree(id, (error, value) => error ? reject(error) : value ? resolve(value) : reject(new Error("Missing compaction revision tree")))
        })
        if (!current() || failed) return
        // Deleted losing leaves are still leaves. Compaction cannot remove them.
        if (tree.some(branch => hasRemovableBody(branch.ids))) {
          await compactDocument(id, 0)
          compacted++
        }
        checked++
      } } catch (error) { failed = true; throw error }
    }))
    const failure = workers.find((worker): worker is PromiseRejectedResult => worker.status === "rejected")
    if (failure) throw failure.reason
    if (!current()) return false
    since = page.last_seq
    const document = { ...checkpoint, _id: CHECKPOINT, last_seq: since }
    const saved = await db.put(document)
    checkpoint = { ...document, _rev: saved.rev }
    progress(checked, compacted)
  }
  return false
}
