import { mergeStoryAssociations, normalizeFeedContent, StoryTag, SubStory } from "@once/core"
import { epochContent } from "./EpochContent"
import { compactLocalRevisions, LocalCompactionDatabase } from "./LocalCompaction"

export interface PouchMaintenanceDatabase extends LocalCompactionDatabase {
  changes?(options: Record<string, unknown>): Promise<{
    results: Array<{ id?: string; doc?: Record<string, unknown> }>
    last_seq: unknown
  }>
  get?(
    id: string,
    options?: Record<string, unknown>
  ): Promise<Record<string, unknown>>
  put?(doc: Record<string, unknown>): Promise<{ rev?: string }>
  bulkDocs?(
    docs: Array<Record<string, unknown>>
  ): Promise<Array<{ error?: string; reason?: string }>>
  compact?(): Promise<unknown>
}

export interface PouchMaintenanceStatus {
  state: "syncing" | "up-to-date" | "error"
  message: string
  changes?: number
}

export class PouchMaintenanceService {
  private static readonly BATCH_SIZE = 100
  /** How far the conflict scan got, as a sequence of this database. */
  static readonly CONFLICT_CHECKPOINT_ID =
    "_local/once-conflict-maintenance-v1"
  /** Present once the one-time compaction has run. */
  static readonly COMPACTION_MARKER_ID =
    "_local/once-compaction-v1"

  constructor(
    private readonly db: PouchMaintenanceDatabase,
    private readonly updateStatus: (status: PouchMaintenanceStatus) => void,
    private readonly reportError: (error: unknown) => void,
    private readonly isCurrent: () => boolean = () => true
  ) {}

  async run(): Promise<boolean> {
    if (!this.db.changes || !this.db.get || !this.db.put || !this.db.bulkDocs) {
      return true
    }
    try {
      let since = await this.readMaintenanceSequence()
      let resolved = 0
      while (this.isCurrent()) {
        const response = await this.db.changes({
          since,
          limit: PouchMaintenanceService.BATCH_SIZE,
          batch_size: PouchMaintenanceService.BATCH_SIZE,
          include_docs: true,
          conflicts: true,
          return_docs: true
        })
        if (response.results.length === 0) break
        this.updateStatus({
          state: "syncing",
          message: resolved
            ? `Consolidating database conflicts (${resolved} resolved)…`
            : "Checking database consistency…",
          changes: resolved
        })
        for (const row of response.results) {
          if (row.doc) resolved += await this.resolveStoryConflicts(row.doc)
        }
        since = response.last_seq
        await this.writeLocalMarker(
          PouchMaintenanceService.CONFLICT_CHECKPOINT_ID,
          { last_seq: since }
        )
      }
      if (!this.isCurrent()) return false
      if (!await this.compactLocalDatabaseOnce()) return false
      this.updateStatus({
        state: "up-to-date",
        message: resolved
          ? `Up to date · ${resolved} database ${resolved === 1 ? "conflict" : "conflicts"} consolidated`
          : "Up to date · database optimized",
        changes: resolved
      })
      return true
    } catch (error) {
      if (!this.isCurrent()) return false
      this.updateStatus({
        state: "error",
        message: "Local database maintenance failed; see the error log"
      })
      this.reportError(error)
      return false
    }
  }

  private async readMaintenanceSequence(): Promise<unknown> {
    try {
      const marker = await this.db.get?.(
        PouchMaintenanceService.CONFLICT_CHECKPOINT_ID
      )
      return marker?.last_seq ?? 0
    } catch (error) {
      if ((error as { status?: number }).status === 404) return 0
      throw error
    }
  }

  private async resolveStoryConflicts(
    winner: Record<string, unknown>
  ): Promise<number> {
    const id = typeof winner._id === "string" ? winner._id : ""
    const conflicts = Array.isArray(winner._conflicts)
      ? winner._conflicts.filter((rev): rev is string => typeof rev === "string").sort()
      : []
    if (!id.startsWith("sto_") || conflicts.length === 0) return 0

    let merged = { ...winner }
    for (const rev of conflicts) {
      const conflicting = await this.db.get?.(id, { rev })
      if (conflicting?._attachments) {
        // Never tombstone unique saved content merely to settle parsed metadata.
        const kept = await this.db.get?.(id, { rev: winner._rev, attachments: true })
        const losing = await this.db.get?.(id, { rev, attachments: true })
        const attachments = kept?._attachments as Record<string, unknown> | undefined
        const candidate = losing?._attachments as Record<string, unknown> | undefined
        const selected = Object.fromEntries(Object.keys(candidate || {}).map(name => [name, attachments?.[name]]))
        const feed = (kept?.stored_content as { source?: string })?.source === "feed" &&
          (losing?.stored_content as { source?: string })?.source === "feed"
        if (Object.values(selected).some(value => !value) ||
            await comparableAttachments(selected, feed) !== await comparableAttachments(candidate || {}, feed)) return 0
      }
      if (conflicting) merged = mergeStoryStateDocuments(merged, conflicting)
    }
    if (!sameStoryStateDocuments(winner, merged)) {
      delete merged._conflicts
      delete merged._deleted_conflicts
      await this.db.put?.(merged)
    }
    const results = await this.db.bulkDocs?.(
      conflicts.map((rev) => ({ _id: id, _rev: rev, _deleted: true }))
    )
    const failure = results?.find((result) => result.error)
    if (failure) {
      throw new Error(
        `Could not remove a losing revision: ${failure.error}: ${failure.reason ?? "unknown error"}`
      )
    }
    return 1
  }

  private async compactLocalDatabaseOnce(): Promise<boolean> {
    if (!this.db.compact || !this.db.get || !this.db.put) return true
    try {
      await this.db.get(PouchMaintenanceService.COMPACTION_MARKER_ID)
      return true
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error
    }
    const startedAt = Date.now()
    const publishProgress = () => {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
      this.updateStatus({
        state: "syncing",
        message: `Compacting local database… ${elapsedSeconds}s elapsed`
      })
    }
    publishProgress()
    const progressTimer = setInterval(publishProgress, 1000)
    try {
      const completed = await compactLocalRevisions(this.db, this.isCurrent, (checked, compacted) => {
        this.updateStatus({ state: "syncing", message: `Compacting local database… ${checked} checked, ${compacted} compacted` })
      })
      if (!completed) return false
      await this.writeLocalMarker(PouchMaintenanceService.COMPACTION_MARKER_ID, {
        completed_at: Date.now()
      })
      return true
    } finally {
      clearInterval(progressTimer)
    }
  }

  private async writeLocalMarker(
    id: string,
    values: Record<string, unknown>
  ): Promise<void> {
    let existing: Record<string, unknown> = { _id: id }
    try {
      existing = await this.db.get?.(id) ?? existing
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error
    }
    await this.db.put?.({ ...existing, ...values })
  }
}

const synchronizedStoryFields = ["read_state", "stared", "filter"] as const

function comparableAttachments(attachments: Record<string, unknown>, feed: boolean): Promise<string> {
  const normalized = { ...attachments }
  const content = normalized.content as { data?: unknown; content_type?: string } | undefined
  if (feed && typeof content?.data === "string") {
    const text = new TextDecoder().decode(Uint8Array.from(atob(content.data), char => char.charCodeAt(0)))
    const bytes = new TextEncoder().encode(normalizeFeedContent(text))
    normalized.content = { content_type: content.content_type,
      data: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join("")) }
  }
  return epochContent({ _attachments: normalized })
}

export function mergeStoryStateDocuments(
  current: Record<string, unknown>,
  candidate: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...current }
  const currentUpdates = timestampRecord(current.sync_updated_at)
  const candidateUpdates = timestampRecord(candidate.sync_updated_at)
  const mergedUpdates = { ...currentUpdates }
  synchronizedStoryFields.forEach((field) => {
    if (field === "filter" && (currentUpdates.filter === 0 || candidateUpdates.filter === 0)) {
      if (currentUpdates.filter !== 0) merged.filter = candidate.filter
      mergedUpdates.filter = 0
      return
    }
    const currentTime = currentUpdates[field] ?? 0
    const candidateTime = candidateUpdates[field] ?? 0
    if (
      candidateTime > currentTime ||
      (candidateTime === currentTime &&
        legacyStoryFieldRank(field, candidate[field]) >
          legacyStoryFieldRank(field, current[field]))
    ) {
      merged[field] = candidate[field]
    }
    const latest = Math.max(currentTime, candidateTime)
    if (latest > 0) mergedUpdates[field] = latest
  })
  if (Object.keys(mergedUpdates).length > 0) {
    merged.sync_updated_at = mergedUpdates
  }
  Object.assign(merged, mergeStoryAssociations(associations(current), associations(candidate)))
  return merged
}

function associations(doc: Record<string, unknown>) {
  return {
    type: typeof doc.type === "string" ? doc.type : "",
    comment_url: typeof doc.comment_url === "string" ? doc.comment_url : "",
    timestamp: typeof doc.timestamp === "number" || typeof doc.timestamp === "string" ? doc.timestamp : 0,
    tags: (Array.isArray(doc.tags) ? doc.tags : []) as StoryTag[],
    substories: (Array.isArray(doc.substories) ? doc.substories : []) as SubStory[]
  }
}

export function sameStoryStateDocuments(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  return synchronizedStoryFields.every((field) => left[field] === right[field]) &&
    JSON.stringify(left.tags || []) === JSON.stringify(right.tags || []) &&
    JSON.stringify(left.substories || []) === JSON.stringify(right.substories || []) &&
    JSON.stringify(timestampRecord(left.sync_updated_at)) ===
      JSON.stringify(timestampRecord(right.sync_updated_at))
}

function timestampRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1])
    )
  )
}

function legacyStoryFieldRank(
  field: typeof synchronizedStoryFields[number],
  value: unknown
): number {
  if (field === "read_state") {
    if (value === "skipped") return 2
    if (value === "read") return 1
    return 0
  }
  if (field === "stared") return value === true ? 1 : 0
  return typeof value === "string" && value ? 1 : 0
}
