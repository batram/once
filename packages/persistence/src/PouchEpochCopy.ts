/**
 * Copies a database's winning revisions, with their ancestry, into another
 * database: the basis of a database epoch, which leaves losing conflict
 * branches and their tombstones behind. Each revision keeps its id and
 * history, so a replica whose winner descends from the copied one still
 * fast-forwards on its next sync instead of conflicting.
 *
 * Replication cannot drop those branches by itself: it lists every leaf of a
 * document, so a replica that still holds one sends it back. A cleanup must
 * therefore move every replica to the copy together, which the epoch cutover
 * coordinates; these functions are only its data step.
 */

import { epochContent } from "./EpochContent"

export interface EpochChange {
  id: string
  changes: Array<{ rev: string }>
  deleted?: boolean
  doc?: { _rev?: string; _deleted?: boolean; _conflicts?: string[] }
}

export interface EpochCopyDatabase {
  changes(options: Record<string, unknown>): Promise<{
    results: EpochChange[]
    last_seq: unknown
  }>
  bulkGet(options: Record<string, unknown>): Promise<{
    results: Array<{
      id: string
      docs: Array<{ ok?: Record<string, unknown>; error?: Record<string, unknown> }>
    }>
  }>
  bulkDocs(
    docs: Array<Record<string, unknown>>,
    options?: Record<string, unknown>
  ): Promise<Array<{ id?: string; error?: string; reason?: string }>>
  get(id: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>
  put(doc: Record<string, unknown>): Promise<{ rev?: string }>
  allDocs(options: Record<string, unknown>): Promise<{
    rows: Array<{ key?: string; error?: string; value?: { rev?: string; deleted?: boolean } }>
  }>
}

/**
 * The source's winner no longer descends from what an earlier run copied:
 * replication made another branch win in between. Writing it would leave
 * both branches in the target, so the copy must start over in an empty one.
 */
export class EpochCopyDivergedError extends Error {
  constructor(readonly ids: string[]) {
    super(`The copy diverged from the source (${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ", …" : ""}): another branch won since an earlier run. Copy again into an empty database.`)
  }
}

export class EpochSourceConflictError extends Error {
  constructor(id: string) { super(`Resolve live conflicts before moving the database: ${id}. All local data has been retained.`) }
}

/** Refuses a batch unless every document the target already holds is an ancestor of the winner being copied. */
async function assertFastForward(target: EpochCopyDatabase, docs: Array<Record<string, unknown>>): Promise<void> {
  const existing = await target.allDocs({ keys: docs.map((doc) => String(doc._id)) })
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]))
  const diverged = existing.rows.filter((row) => {
    const held = row.value?.rev
    if (!row.key || !held) return false
    const revisions = byId.get(row.key)?._revisions as { start?: number; ids?: string[] } | undefined
    const [position, hash] = held.split("-")
    const index = Number(revisions?.start) - Number(position)
    return revisions?.ids?.[index] !== hash
  }).map((row) => String(row.key))
  if (diverged.length > 0) throw new EpochCopyDivergedError(diverged)
}

export interface EpochCopyOptions {
  /** Documents that must not move to the new epoch. */
  exclude?: (id: string) => boolean
  batchSize?: number
  onProgress?: (progress: { copied: number; skipped: number }) => void
  isCurrent?: () => boolean
}

export interface EpochCopyResult {
  copied: number
  skipped: number
  lastSeq: unknown
}

const COPY_CHECKPOINT_ID = "_local/once-epoch-copy"
export const EPOCH_BATCH_SIZE = 500
export type EpochMigrationProgress = (processed: number, phase?: "copy" | "reconcile" | "verify") => void

function checkedBatchSize(value = EPOCH_BATCH_SIZE): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Epoch batch size must be a positive integer")
  return value
}

/**
 * Copies every winner the source holds, deleted documents included: a
 * replica that still holds a live revision of a document deleted elsewhere
 * finds that revision in the tombstone's history and stays deleted.
 * Resumable: the target remembers how far it got, and running it again after
 * the source changed copies only what changed since.
 */
export async function copyWinningRevisions(
  source: EpochCopyDatabase,
  target: EpochCopyDatabase,
  sourceId: string,
  options: EpochCopyOptions = {}
): Promise<EpochCopyResult> {
  const batchSize = checkedBatchSize(options.batchSize)
  const checkpoint = await readLocal(target, COPY_CHECKPOINT_ID)
  let since = checkpoint?.source === sourceId ? checkpoint.last_seq : 0
  let copied = 0
  let skipped = 0
  for (;;) {
    if (options.isCurrent && !options.isCurrent()) throw new Error("Sync session changed during epoch migration")
    // limit bounds this logical page; batch_size also bounds HTTP requests.
    // Without it PouchDB splits the page into serial 25-document requests.
    const page = await source.changes({ since, limit: batchSize, batch_size: batchSize, style: "main_only", include_docs: true, conflicts: true })
    if (page.results.length === 0) break
    const wanted = page.results.filter((change) => {
      const keep = !change.id.startsWith("_local/") && !options.exclude?.(change.id)
      if (!keep) skipped++
      return keep
    })
    if (wanted.length > 0) {
      for (const change of wanted) if (change.doc?._conflicts?.length) throw new EpochSourceConflictError(change.id)
      const fetched = await source.bulkGet({
        docs: wanted.map((change) => ({ id: change.id, rev: change.changes[0].rev })),
        revs: true,
        attachments: true
      })
      const byId = new Map(fetched.results.map(result => [result.id, result]))
      const docs = wanted.map(change => {
        const result = byId.get(change.id)
        const doc = result?.docs[0]?.ok
        if (!doc) {
          throw new Error(`Could not read the winning revision of ${change.id}`)
        }
        return doc
      })
      const contents: string[] = []
      for (const doc of docs) contents.push(await epochContent(doc))
      if (options.isCurrent && !options.isCurrent()) throw new Error("Sync session changed during epoch migration")
      await assertFastForward(target, docs)
      const written = await target.bulkDocs(docs, { new_edits: false })
      const failure = written.find((result) => result.error)
      if (failure) {
        throw new Error(`Could not copy ${failure.id}: ${failure.error}: ${failure.reason ?? "unknown error"}`)
      }
      // Verify the exact revisions just read, not a later moving snapshot of
      // a live canonical epoch. A replica may legitimately advance meanwhile.
      const checked = await target.bulkGet({ docs: docs.map(doc => ({ id: doc._id, rev: doc._rev })), attachments: true })
      const copies = new Map(checked.results.map(row => [row.id, row.docs[0]?.ok]))
      for (const [index, doc] of docs.entries()) {
        const copy = copies.get(String(doc._id))
        if (!copy || contents[index] !== await epochContent(copy)) throw new Error(`Copied epoch content differs: ${String(doc._id)}`)
      }
      copied += docs.length
    }
    since = page.last_seq
    await writeLocal(target, COPY_CHECKPOINT_ID, { source: sourceId, last_seq: since })
    options.onProgress?.({ copied, skipped })
  }
  return { copied, skipped, lastSeq: since }
}

export interface RevisionCensus {
  documents: number
  deletedDocuments: number
  conflictedDocuments: number
  /** Leaves beyond the winner: live conflicts plus deleted losing branches. */
  extraLeaves: number
  liveConflicts: string[]
  winners: Map<string, { rev: string; deleted: boolean; leaves: number }>
}

/** Read-only: every document's winner and how many leaves it carries. */
export async function censusRevisions(
  db: Pick<EpochCopyDatabase, "changes">,
  batchSize = EPOCH_BATCH_SIZE,
  onProgress?: (documents: number) => void
): Promise<RevisionCensus> {
  batchSize = checkedBatchSize(batchSize)
  const census: RevisionCensus = {
    documents: 0,
    deletedDocuments: 0,
    conflictedDocuments: 0,
    extraLeaves: 0,
    liveConflicts: [],
    winners: new Map()
  }
  const conflicts = new Set<string>()
  let since: unknown = 0
  for (;;) {
    // all_docs supplies every leaf; include_docs supplies the actual winner.
    // The first leaf is NOT necessarily the winner, particularly after deletes.
    const page = await db.changes({ since, limit: batchSize, batch_size: batchSize, style: "all_docs", include_docs: true, conflicts: true })
    if (page.results.length === 0) break
    for (const change of page.results) {
      if (change.id.startsWith("_local/")) continue
      const rev = change.doc?._rev
      if (!rev || !change.changes.some(leaf => leaf.rev === rev)) throw new Error(`Could not read the census winner of ${change.id}`)
      if (change.doc?._conflicts?.length) conflicts.add(change.id); else conflicts.delete(change.id)
      census.winners.set(change.id, { rev, deleted: change.deleted === true || change.doc?._deleted === true, leaves: change.changes.length })
    }
    since = page.last_seq
    onProgress?.(census.winners.size)
  }
  census.liveConflicts = [...conflicts]
  for (const entry of census.winners.values()) {
    census.documents++
    if (entry.deleted) census.deletedDocuments++
    if (entry.leaves > 1) {
      census.conflictedDocuments++
      census.extraLeaves += entry.leaves - 1
    }
  }
  return census
}

export interface EpochVerification {
  ok: boolean
  /** Source winners the target lacks or holds at another revision. */
  mismatched: string[]
  /** Target documents with more than one leaf. */
  conflicted: string[]
  /** Target documents the source does not have, such as writes after cutover. */
  extra: string[]
  contentMismatched: string[]
  unresolved: string[]
}

export interface EpochVerificationOptions extends Pick<EpochCopyOptions, "exclude" | "batchSize"> {
  onProgress?: (progress: { phase: "source-census" | "target-census" | "content"; processed: number; total?: number }) => void
}

/** Read-only: whether the target holds exactly the source's winners, each as its only leaf. */
export async function verifyWinningRevisions(
  source: EpochCopyDatabase,
  target: EpochCopyDatabase,
  options: EpochVerificationOptions = {}
): Promise<EpochVerification> {
  const batchSize = checkedBatchSize(options.batchSize)
  const [from, to] = await Promise.all([
    censusRevisions(source, batchSize, processed => options.onProgress?.({ phase: "source-census", processed })),
    censusRevisions(target, batchSize, processed => options.onProgress?.({ phase: "target-census", processed }))
  ])
  const mismatched: string[] = []
  const conflicted: string[] = []
  const extra: string[] = []
  const contentMismatched: string[] = []
  const unresolved = from.liveConflicts.filter(id => !options.exclude?.(id))
  for (const [id, winner] of from.winners) {
    if (options.exclude?.(id)) continue
    const copy = to.winners.get(id)
    if (!copy || copy.rev !== winner.rev || copy.deleted !== winner.deleted) mismatched.push(id)
  }
  for (const [id, copy] of to.winners) {
    if (options.exclude?.(id)) continue
    if (copy.leaves > 1) conflicted.push(id)
    if (!from.winners.has(id)) extra.push(id)
  }
  const matching = [...from.winners].filter(([id, winner]) => !options.exclude?.(id) && to.winners.get(id)?.rev === winner.rev)
  for (let offset = 0; offset < matching.length; offset += batchSize) {
    const docs = matching.slice(offset, offset + batchSize).map(([id, winner]) => ({ id, rev: winner.rev }))
    const [left, right] = await Promise.all([source.bulkGet({ docs, attachments: true }), target.bulkGet({ docs, attachments: true })])
    const originals = new Map(left.results.map(row => [row.id, row.docs[0]?.ok]))
    const copies = new Map(right.results.map(row => [row.id, row.docs[0]?.ok]))
    for (const { id } of docs) {
      const original = originals.get(id), copy = copies.get(id)
      if (!original || !copy || await epochContent(original) !== await epochContent(copy)) contentMismatched.push(id)
    }
    options.onProgress?.({ phase: "content", processed: offset + docs.length, total: matching.length })
  }
  return { ok: !mismatched.length && !conflicted.length && !extra.length && !contentMismatched.length && !unresolved.length,
    mismatched, conflicted, extra, contentMismatched, unresolved }
}

async function readLocal(
  db: EpochCopyDatabase,
  id: string
): Promise<Record<string, unknown> | null> {
  try {
    return await db.get(id)
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null
    throw error
  }
}

async function writeLocal(
  db: EpochCopyDatabase,
  id: string,
  values: Record<string, unknown>
): Promise<void> {
  const existing = await readLocal(db, id)
  await db.put({ ...existing, _id: id, ...values })
}
