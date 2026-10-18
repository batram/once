import { epochContent } from "./EpochContent"
import { censusRevisions, copyWinningRevisions, EpochCopyDatabase, EpochSourceConflictError } from "./PouchEpochCopy"
import { isSyncMetadataId } from "@once/core"

function ancestor(rev: string, doc: Record<string, unknown>): boolean {
  if (rev === doc._rev) return true
  const [generation, hash] = rev.split("-")
  const history = doc._revisions as { start: number; ids: string[] } | undefined
  return history?.ids[history.start - Number(generation)] === hash
}

/** Seed from the canonical epoch, then admit only provable local extensions. */
export async function reconcileEpoch(local: EpochCopyDatabase, canonical: EpochCopyDatabase, previous: EpochCopyDatabase,
  target: EpochCopyDatabase, destination: string, progress: (copied: number) => void, isCurrent = () => true): Promise<void> {
  const options = { exclude: isSyncMetadataId, batchSize: 200, isCurrent, onProgress: (step: { copied: number }) => progress(step.copied) }
  await copyWinningRevisions(canonical, target, `remote:${destination}`, options)
  let since: unknown = 0
  for (;;) {
    if (!isCurrent()) throw new Error("Sync session changed during epoch migration")
    const page = await local.changes({ since, limit: 50, include_docs: true, conflicts: true })
    if (!page.results.length) break
    const wanted = page.results.filter(row => !isSyncMetadataId(row.id) && !row.id.startsWith("_local/"))
    if (!wanted.length) { since = page.last_seq; continue }
    const localDocs = await local.bulkGet({ docs: wanted.map(row => ({ id: row.id, rev: row.changes[0].rev })), revs: true, attachments: true })
    const originals = new Map(localDocs.results.map(row => [row.id, row.docs[0]?.ok]))
    const targetRows = (await target.allDocs({ keys: wanted.map(row => row.id) })).rows
    const targetRequests = targetRows.filter(row => row.value?.rev).map(row => ({ id: row.key, rev: row.value?.rev }))
    const targetDocs = targetRequests.length ? await target.bulkGet({ docs: targetRequests, revs: true, attachments: true }) : { results: [] }
    const copies = new Map(targetDocs.results.map(row => [row.id, row.docs[0]?.ok]))
    for (const row of wanted) {
      if (row.doc?._conflicts?.length) throw new EpochSourceConflictError(row.id)
      const doc = originals.get(row.id), held = copies.get(row.id)
      if (!doc || targetRows.some(entry => entry.key === row.id && entry.value?.rev) && !held) throw new Error(`Could not read epoch reconciliation data: ${row.id}`)
      if (held && held._rev === doc._rev) {
        if (await epochContent(held) !== await epochContent(doc)) throw new Error(`Epoch content differs under the same revision: ${row.id}. Repair it before moving; local data is retained.`)
        continue
      }
      if (held && ancestor(String(doc._rev), held)) continue // canonical descendant already includes this state
      if (held && !ancestor(String(held._rev), doc)) {
        // A stale replica may still call a deleted losing branch its winner.
        // Only discard it if the frozen source proves that exact revision was retired.
        const leaves = await previous.get(row.id, { open_revs: "all", revs: true }) as unknown as Array<{ ok?: Record<string, unknown> }>
        if (leaves.some(leaf => leaf.ok?._deleted && ancestor(String(doc._rev), leaf.ok))) continue
        throw new Error(`Local epoch ancestry cannot be reconciled automatically: ${row.id}. Resolve or export the pending edit; all local data is retained.`)
      }
      await epochContent(doc)
      const result = await target.bulkDocs([doc], { new_edits: false })
      if (result.some(item => item.error)) throw new Error(`Could not preserve the local epoch edit: ${row.id}`)
      const written = await target.get(row.id, { rev: String(doc._rev), attachments: true })
      if (await epochContent(doc) !== await epochContent(written)) throw new Error(`Local epoch content verification failed: ${row.id}`)
    }
    since = page.last_seq
  }
  if ((await censusRevisions(target)).extraLeaves) throw new Error("The rebuilt epoch has conflicting branches; local data is retained")
}
