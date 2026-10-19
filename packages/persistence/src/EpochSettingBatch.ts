import type { SyncSettingResolution } from "@once/core"
import type { EpochCopyDatabase } from "./PouchEpochCopy"
import { EpochSettingReviewError, resolveEpochSetting, reviewableSettingIds, reviewEpochSetting } from "./EpochSettingReview"
import { preflightEpochSettings } from "./EpochReconciliationPolicy"

/** One explicit operation, under the epoch lock. Never remembers a policy for future syncs. */
export async function resolveEpochSettingBatch(local: Pick<EpochCopyDatabase, "get" | "put" | "bulkDocs" | "allDocs">, remote: EpochCopyDatabase,
  previous: EpochCopyDatabase, choice: SyncSettingResolution, isCurrent: () => boolean): Promise<void> {
  const policy = choice.applyToAll
  if (!policy) { await resolveEpochSetting(local, remote, choice, isCurrent); return }
  const reviewed = await reviewEpochSetting(local, remote, choice.id)
  const selected = policy === "synced" ? "remote" : reviewed.currentLocalRevision
  if (choice.choice !== selected) throw new Error("The selected version changed. Review again.")
  await resolveEpochSetting(local, remote, choice, isCurrent)
  const resolved = new Set([choice.id])
  for (let remaining = reviewableSettingIds.length; remaining > 0; remaining--) {
    if (!isCurrent()) throw new Error("The sync session changed. Completed choices and backups are retained.")
    try { await preflightEpochSettings(local, remote, previous); return } catch (error) {
      if (!(error instanceof EpochSettingReviewError)) throw error
      if (resolved.has(error.documentId)) throw new Error("A setting changed during resolution. Completed choices and backups are retained; review again.")
      const next = await reviewEpochSetting(local, remote, error.documentId)
      if (policy === "synced" && !next.choices.some(entry => entry.key === "remote")) {
        throw new Error(`No synced version exists for ${next.label}. Completed choices are saved; review this setting separately.`)
      }
      await resolveEpochSetting(local, remote, { ...next, choice: policy === "synced" ? "remote" : next.currentLocalRevision }, isCurrent)
      resolved.add(next.id)
    }
  }
}
