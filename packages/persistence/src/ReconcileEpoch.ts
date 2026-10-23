import { epochContent } from "./EpochContent"
import { censusRevisions, copyWinningRevisions, EPOCH_BATCH_SIZE, EpochCopyDatabase, EpochMigrationProgress, EpochSourceConflictError } from "./PouchEpochCopy"
import { ADDON_VAULT_ID, isSyncMetadataId, THUMB_DOC_PREFIX } from "@once/core"
import { EpochSettingReviewError, reviewableSetting } from "./EpochSettingReview"
import { epochAncestor as ancestor, isRetiredEpochRevision, preflightEpochSettings, reconcileDevicePublication } from "./EpochReconciliationPolicy"
import { reconcileEpochStory } from "./EpochStoryReconciliation"

/** Seed from the canonical epoch, then admit only provable local extensions. */
export async function reconcileEpoch(local: EpochCopyDatabase, canonical: EpochCopyDatabase, previous: EpochCopyDatabase,
  target: EpochCopyDatabase, destination: string, progress: EpochMigrationProgress, isCurrent = () => true): Promise<void> {
  const options = { exclude: isSyncMetadataId, batchSize: EPOCH_BATCH_SIZE, isCurrent, onProgress: (step: { copied: number }) => progress(step.copied) }
  const { canonicalSettings, equalLocalBranches } = await preflightEpochSettings(local, canonical, previous)
  await copyWinningRevisions(canonical, target, `remote:${destination}`, options)
  let since: unknown = 0
  let reconciled = 0
  for (;;) {
    if (!isCurrent()) throw new Error("Sync session changed during epoch migration")
    const page = await local.changes({ since, limit: EPOCH_BATCH_SIZE, batch_size: EPOCH_BATCH_SIZE, include_docs: true, conflicts: true })
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
      const doc = originals.get(row.id), held = copies.get(row.id)
      if (!doc || targetRows.some(entry => entry.key === row.id && entry.value?.rev) && !held) throw new Error(`Could not read epoch reconciliation data: ${row.id}`)
      if (canonicalSettings.has(row.id)) {
        if (!held || await epochContent(held) !== await epochContent(doc)) throw new EpochSettingReviewError(row.id)
        continue
      }
      const conflicted = Boolean(row.doc?._conflicts?.length)
      // Thumbnail slots are a cache their device rewrites and any device may
      // empty in place, so a forked copy holds nothing worth keeping. A forked
      // add-on vault also takes the canonical snapshot; the retired database
      // keeps the local one.
      if (held && (row.id.startsWith(THUMB_DOC_PREFIX) || row.id === ADDON_VAULT_ID) &&
        (conflicted || !ancestor(String(held._rev), doc))) continue
      if (conflicted && await reconcileEpochStory(local, previous, target, doc, held, true, isCurrent)) continue
      if ((conflicted || held && !ancestor(String(held._rev), doc)) &&
        await reconcileDevicePublication(local, target, doc, held, conflicted)) continue
      if (conflicted && !equalLocalBranches.has(row.id)) throw reviewableSetting(row.id) ? new EpochSettingReviewError(row.id) : new EpochSourceConflictError(row.id)
      if (held && held._rev === doc._rev) {
        if (await epochContent(held) !== await epochContent(doc)) throw new Error(`Epoch content differs under the same revision: ${row.id}. Repair it before moving; local data is retained.`)
        continue
      }
      if (held && ancestor(String(doc._rev), held)) continue // canonical descendant already includes this state
      if (held && !ancestor(String(held._rev), doc)) {
        // A stale replica may still call a deleted losing branch its winner.
        // Only discard it if the frozen source proves that exact revision was retired.
        if (await isRetiredEpochRevision(previous, row.id, String(doc._rev))) continue
        if (await reconcileEpochStory(local, previous, target, doc, held, false, isCurrent)) continue
        if (reviewableSetting(row.id)) throw new EpochSettingReviewError(row.id)
        throw new Error(`Local epoch ancestry cannot be reconciled automatically: ${row.id}. Resolve or export the pending edit; all local data is retained.`)
      }
      await epochContent(doc)
      const result = await target.bulkDocs([doc], { new_edits: false })
      if (result.some(item => item.error)) throw new Error(`Could not preserve the local epoch edit: ${row.id}`)
      const written = await target.get(row.id, { rev: String(doc._rev), attachments: true })
      if (await epochContent(doc) !== await epochContent(written)) throw new Error(`Local epoch content verification failed: ${row.id}`)
    }
    since = page.last_seq
    reconciled += wanted.length
    progress(reconciled, "reconcile")
  }
  if ((await censusRevisions(target, EPOCH_BATCH_SIZE, checked => progress(checked, "verify"))).extraLeaves) throw new Error("The rebuilt epoch has conflicting branches; local data is retained")
}
