import { epochContent, sha256 } from "./EpochContent"
import { epochAncestor, isRetiredEpochRevision } from "./EpochReconciliationPolicy"
import { mergeStoryStateDocuments, sameStoryStateDocuments } from "./PouchMaintenanceService"
import type { EpochCopyDatabase } from "./PouchEpochCopy"

/** Apply normal story semantics to unrelated histories without importing another live branch. */
export async function reconcileEpochStory(local: EpochCopyDatabase, previous: EpochCopyDatabase, target: EpochCopyDatabase,
  doc: Record<string, unknown>, held: Record<string, unknown> | undefined, conflicted: boolean,
  isCurrent: () => boolean): Promise<boolean> {
  const id = String(doc._id)
  const valid = (value: Record<string, unknown>) => value._id === id && value.href === id.slice(4) &&
    /^sto_https?:\/\//.test(id) && typeof value.title === "string" && !value._deleted
  if (!valid(doc) || held && !valid(held)) return false
  let candidates = [doc]
  if (conflicted) {
    const rows = await local.get(id, { open_revs: "all", revs: true, attachments: true }) as unknown as Array<{ ok?: Record<string, unknown> }>
    if (!Array.isArray(rows) || rows.some(row => !row.ok)) throw new Error(`Could not read every story version: ${id}`)
    candidates = rows.flatMap(row => row.ok && !row.ok._deleted ? [row.ok] : []).sort((a, b) => String(a._rev).localeCompare(String(b._rev)))
  }
  if (candidates.some(candidate => !valid(candidate))) return false
  const contents = new Map<unknown, string>()
  for (const candidate of [...candidates, ...(held ? [held] : [])]) {
    const content = await epochContent(candidate)
    if (contents.has(candidate._rev) && contents.get(candidate._rev) !== content) throw new Error(`Epoch content differs under the same revision: ${id}`)
    contents.set(candidate._rev, content)
  }
  let merged = { ...(held ?? doc) }
  for (const candidate of candidates) {
    if (held && epochAncestor(String(candidate._rev), held)) continue
    if (conflicted && await isRetiredEpochRevision(previous, id, String(candidate._rev))) continue
    merged = mergeStoryStateDocuments(merged, candidate)
    const kept = merged._attachments as Record<string, unknown> | undefined
    const incoming = candidate._attachments as Record<string, unknown> | undefined
    if (!incoming) continue
    if (!kept || Object.keys(kept).length === 0) {
      merged._attachments = incoming
      if (candidate.stored_content !== undefined) merged.stored_content = candidate.stored_content
      else delete merged.stored_content
    } else if (await epochContent({ _attachments: kept }) !== await epochContent({ _attachments: incoming })) {
      // Keep alternate saved bytes in the new database too, not only in the retired source.
      const backupId = `_local/once-epoch-story-${await sha256(new TextEncoder().encode(`${id}\n${String(candidate._rev)}`))}`
      let backup: Record<string, unknown> | undefined
      try { backup = await target.get(backupId) } catch (error) { if ((error as { status?: number }).status !== 404) throw error }
      if (!isCurrent()) throw new Error("Sync session changed during epoch migration")
      if (backup && await epochContent(backup.original as Record<string, unknown>) !== contents.get(candidate._rev)) throw new Error(`Story recovery backup differs: ${id}`)
      if (!backup) await target.put({ _id: backupId, storyId: id, original: candidate, reason: "Alternate saved content retained during epoch migration" })
      const saved = await target.get(backupId)
      if (await epochContent(saved.original as Record<string, unknown>) !== contents.get(candidate._rev)) throw new Error(`Story recovery backup verification failed: ${id}`)
    }
  }
  // Avoid revisions for parsed titles, timestamps and absent-versus-empty association arrays.
  if (held && sameStoryStateDocuments(held, merged) &&
      await epochContent({ _attachments: held._attachments }) === await epochContent({ _attachments: merged._attachments })) return true
  merged = Object.fromEntries(Object.entries(merged).filter(([key]) => !key.startsWith("_") || key === "_id" || key === "_attachments"))
  if (held) merged._rev = held._rev
  await epochContent(merged)
  if (!isCurrent()) throw new Error("Sync session changed during epoch migration")
  const written = await target.put(merged)
  const verified = await target.get(id, { rev: written.rev, attachments: true })
  if (await epochContent(verified) !== await epochContent(merged)) throw new Error(`Story reconciliation verification failed: ${id}`)
  return true
}
