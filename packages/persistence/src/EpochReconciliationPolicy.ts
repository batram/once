import { comparePublications, readDeviceDoc } from "@once/core"
import { epochContent } from "./EpochContent"
import { EpochSettingReviewError, reviewableSettingIds } from "./EpochSettingReview"
import type { EpochCopyDatabase } from "./PouchEpochCopy"

export function epochAncestor(rev: string, doc: Record<string, unknown>): boolean {
  if (rev === doc._rev) return true
  const [generation, hash] = rev.split("-")
  const history = doc._revisions as { start: number; ids: string[] } | undefined
  return history?.ids[history.start - Number(generation)] === hash
}

export async function isRetiredEpochRevision(previous: EpochCopyDatabase, id: string, rev: string): Promise<boolean> {
  try {
    const leaves = await previous.get(id, { open_revs: "all", revs: true }) as unknown as Array<{ ok?: Record<string, unknown> }>
    return leaves.some(leaf => leaf.ok?._deleted && epochAncestor(rev, leaf.ok))
  } catch (error) {
    if ((error as { status?: number }).status === 404) return false
    throw error
  }
}

async function liveVersions(db: EpochCopyDatabase, id: string): Promise<Record<string, unknown>[]> {
  const rows = await db.get(id, { open_revs: "all", revs: true, attachments: true }) as unknown as Array<{ ok?: Record<string, unknown> }>
  if (!Array.isArray(rows) || rows.some(row => !row.ok)) throw new Error(`Could not read every version: ${id}`)
  return rows.flatMap(row => row.ok && !row.ok._deleted ? [row.ok] : [])
}

/** Check the small settings set before any archive scan; retain originals in the old database. */
export async function preflightEpochSettings(local: EpochCopyDatabase, canonical: EpochCopyDatabase, previous: EpochCopyDatabase) {
  const canonicalSettings = new Set<string>(), equalLocalBranches = new Set<string>()
  const [locals, remotes] = await Promise.all([local.allDocs({ keys: reviewableSettingIds }), canonical.allDocs({ keys: reviewableSettingIds })])
  for (const row of locals.rows) {
    if (!row.key || !row.value?.rev || row.value.deleted) continue
    const id = row.key, remote = remotes.rows.find(entry => entry.key === id)
    const [doc, held] = await Promise.all([
      local.get(id, { rev: row.value.rev, revs: true, conflicts: true, attachments: true }),
      remote?.value?.rev ? canonical.get(id, { rev: remote.value.rev, revs: true, attachments: true }) : undefined
    ])
    const versions = (doc._conflicts as string[] | undefined)?.length ? await liveVersions(local, id) : [doc]
    const contents = await Promise.all(versions.map(epochContent)), content = await epochContent(doc)
    const heldContent = held ? await epochContent(held) : undefined
    if (held && versions.some((version, index) => version._rev === held._rev && contents[index] !== heldContent)) {
      throw new Error(`Epoch content differs under the same revision: ${id}. Repair it before moving; local data is retained.`)
    }
    if (contents.every(entry => entry === content)) {
      equalLocalBranches.add(id)
      if (heldContent === content) { canonicalSettings.add(id); continue }
    } else throw new EpochSettingReviewError(id)
    if (held && !epochAncestor(String(doc._rev), held) && !epochAncestor(String(held._rev), doc)) {
      if (!await isRetiredEpochRevision(previous, id, String(doc._rev))) throw new EpochSettingReviewError(id)
    }
  }
  return { canonicalSettings, equalLocalBranches }
}

/** Device publications already have a deterministic domain order, independent of Couch ancestry. */
export async function reconcileDevicePublication(local: EpochCopyDatabase, target: EpochCopyDatabase,
  doc: Record<string, unknown>, held: Record<string, unknown> | undefined, conflicted: boolean): Promise<boolean> {
  if (!readDeviceDoc(doc) || held && !readDeviceDoc(held)) return false
  const candidates = conflicted ? await liveVersions(local, String(doc._id)) : [doc]
  if (held) candidates.push(held)
  if (candidates.some(candidate => !readDeviceDoc(candidate) || candidate._attachments)) return false
  const contents = new Map<unknown, string>()
  for (const candidate of candidates) {
    const content = await epochContent(candidate)
    if (contents.has(candidate._rev) && contents.get(candidate._rev) !== content) throw new Error(`Epoch content differs under the same revision: ${String(doc._id)}`)
    contents.set(candidate._rev, content)
  }
  let winner = candidates[0]
  for (const candidate of candidates.slice(1)) {
    const publication = readDeviceDoc(candidate), current = readDeviceDoc(winner)
    if (publication && current && comparePublications(publication, current) > 0) winner = candidate
  }
  if (held && await epochContent(winner) === await epochContent(held)) return true
  // Rebase the selected publication on the staged canonical branch. Never write the source or server.
  const body = Object.fromEntries(Object.entries(winner).filter(([key]) => !key.startsWith("_")))
  const written = await target.put({ _id: doc._id, ...(held ? { _rev: held._rev } : {}), ...body })
  const verified = await target.get(String(doc._id), { rev: written.rev })
  if (await epochContent(verified) !== await epochContent(winner)) throw new Error(`Device publication verification failed: ${String(doc._id)}`)
  return true
}
