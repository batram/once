export interface PouchMaintenanceDatabase {
  changes?(options: Record<string, unknown>): Promise<{
    results: Array<{ doc?: Record<string, unknown> }>
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
  private static readonly CONFLICT_CHECKPOINT_ID =
    "_local/once-conflict-maintenance-v1"
  private static readonly COMPACTION_MARKER_ID =
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
      await this.compactLocalDatabaseOnce()
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
      ? winner._conflicts.filter((rev): rev is string => typeof rev === "string")
      : []
    if (!id.startsWith("sto_") || conflicts.length === 0) return 0

    let merged = { ...winner }
    for (const rev of conflicts) {
      const conflicting = await this.db.get?.(id, { rev })
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

  private async compactLocalDatabaseOnce(): Promise<void> {
    if (!this.db.compact || !this.db.get || !this.db.put) return
    try {
      await this.db.get(PouchMaintenanceService.COMPACTION_MARKER_ID)
      return
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
      await this.db.compact()
      await this.writeLocalMarker(PouchMaintenanceService.COMPACTION_MARKER_ID, {
        completed_at: Date.now()
      })
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

function mergeStoryStateDocuments(
  current: Record<string, unknown>,
  candidate: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...current }
  const currentUpdates = timestampRecord(current.sync_updated_at)
  const candidateUpdates = timestampRecord(candidate.sync_updated_at)
  const mergedUpdates = { ...currentUpdates }
  synchronizedStoryFields.forEach((field) => {
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
  return merged
}

function sameStoryStateDocuments(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  return synchronizedStoryFields.every((field) => left[field] === right[field]) &&
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
