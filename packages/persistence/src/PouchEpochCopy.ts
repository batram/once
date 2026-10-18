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

export interface EpochChange {
  id: string
  changes: Array<{ rev: string }>
  deleted?: boolean
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
}

export interface EpochCopyOptions {
  /** Documents that must not move to the new epoch. */
  exclude?: (id: string) => boolean
  batchSize?: number
  onProgress?: (progress: { copied: number; skipped: number }) => void
}

export interface EpochCopyResult {
  copied: number
  skipped: number
  lastSeq: unknown
}

const COPY_CHECKPOINT_ID = "_local/once-epoch-copy"

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
  const batchSize = options.batchSize ?? 50
  const checkpoint = await readLocal(target, COPY_CHECKPOINT_ID)
  let since = checkpoint?.source === sourceId ? checkpoint.last_seq : 0
  let copied = 0
  let skipped = 0
  for (;;) {
    const page = await source.changes({ since, limit: batchSize, style: "main_only" })
    if (page.results.length === 0) break
    const wanted = page.results.filter((change) => {
      const keep = !change.id.startsWith("_local/") && !options.exclude?.(change.id)
      if (!keep) skipped++
      return keep
    })
    if (wanted.length > 0) {
      const fetched = await source.bulkGet({
        docs: wanted.map((change) => ({ id: change.id, rev: change.changes[0].rev })),
        revs: true,
        attachments: true
      })
      const docs = fetched.results.map((result) => {
        const doc = result.docs[0]?.ok
        if (!doc) {
          throw new Error(`Could not read the winning revision of ${result.id}: ${JSON.stringify(result.docs[0]?.error)}`)
        }
        return doc
      })
      const written = await target.bulkDocs(docs, { new_edits: false })
      const failure = written.find((result) => result.error)
      if (failure) {
        throw new Error(`Could not copy ${failure.id}: ${failure.error}: ${failure.reason ?? "unknown error"}`)
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
  winners: Map<string, { rev: string; deleted: boolean; leaves: number }>
}

/** Read-only: every document's winner and how many leaves it carries. */
export async function censusRevisions(
  db: Pick<EpochCopyDatabase, "changes">,
  batchSize = 500
): Promise<RevisionCensus> {
  const census: RevisionCensus = {
    documents: 0,
    deletedDocuments: 0,
    conflictedDocuments: 0,
    extraLeaves: 0,
    winners: new Map()
  }
  const winners = new Map<string, { rev: string; deleted: boolean }>()
  for (const style of ["main_only", "all_docs"] as const) {
    let since: unknown = 0
    for (;;) {
      const page = await db.changes({ since, limit: batchSize, style })
      if (page.results.length === 0) break
      for (const change of page.results) {
        if (change.id.startsWith("_local/")) continue
        if (style === "main_only") {
          winners.set(change.id, { rev: change.changes[0].rev, deleted: change.deleted === true })
          continue
        }
        const winner = winners.get(change.id)
        if (!winner) continue
        census.winners.set(change.id, { ...winner, leaves: change.changes.length })
      }
      since = page.last_seq
    }
  }
  for (const [id, winner] of winners) {
    const entry = census.winners.get(id) ?? { ...winner, leaves: 1 }
    census.winners.set(id, entry)
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
}

/** Read-only: whether the target holds exactly the source's winners, each as its only leaf. */
export async function verifyWinningRevisions(
  source: Pick<EpochCopyDatabase, "changes">,
  target: Pick<EpochCopyDatabase, "changes">,
  options: Pick<EpochCopyOptions, "exclude"> = {}
): Promise<EpochVerification> {
  const [from, to] = await Promise.all([censusRevisions(source), censusRevisions(target)])
  const mismatched: string[] = []
  const conflicted: string[] = []
  const extra: string[] = []
  for (const [id, winner] of from.winners) {
    if (options.exclude?.(id)) continue
    const copy = to.winners.get(id)
    if (!copy || copy.rev !== winner.rev || copy.deleted !== winner.deleted) mismatched.push(id)
  }
  for (const [id, copy] of to.winners) {
    if (copy.leaves > 1) conflicted.push(id)
    if (!from.winners.has(id)) extra.push(id)
  }
  return { ok: mismatched.length === 0 && conflicted.length === 0, mismatched, conflicted, extra }
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
