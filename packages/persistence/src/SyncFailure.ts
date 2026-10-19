import { SyncCompatibilityError } from "./PouchSyncCompatibility"
import { syncRequestDetails } from "./SyncFetchDiagnostics"
import { SyncEpochPendingError } from "./SyncEpoch"
import { EpochSettingReviewError } from "./EpochSettingReview"

export function syncFailure(error: unknown): { operation: string; message: string; retry: boolean } {
  if (error instanceof EpochSettingReviewError) return { operation: "sync.settings-review", message: error.message, retry: false }
  if (error instanceof SyncEpochPendingError) return { operation: "sync.epoch", message: error.message, retry: true }
  if (error instanceof SyncCompatibilityError && error.compatibility &&
    error.compatibility.requiredSyncProtocol > error.compatibility.supportedSyncProtocol) return {
    operation: "sync.compatibility", message: error.message, retry: false
  }
  const fields = error && typeof error === "object" ? error as Record<string, unknown> : {}
  const message = String(fields.message ?? error)
  const status = Number(fields.status ?? syncRequestDetails(error)?.status ?? 0)
  if (status === 401 || status === 403 || /^(unauthorized|forbidden)$/i.test(String(fields.name))) return {
    operation: "sync.authorization", message: "Sync paused. Check the database credentials and access permissions.", retry: false
  }
  if (error instanceof SyncCompatibilityError || /metadata.*(unsupported|damaged|removed|lowered)/i.test(message)) return {
    operation: "sync.metadata", message: "Sync paused. The database sync metadata needs attention. Your local data is retained.", retry: false
  }
  const retry = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500 && status <= 599 ||
    (!status || status === 200) && (Boolean(syncRequestDetails(error)) ||
      /fetch|network|connection|content-length|response body|timeout|timed out|abort|socket|ECONN|ENET|EAI_AGAIN|changed repeatedly/i.test(`${fields.name ?? ""} ${message} ${fields.code ?? ""}`))
  return retry
    ? { operation: "sync.retry", message: "Connection interrupted. Sync will retry automatically.", retry: true }
    : { operation: "sync.replication", message: status === 404
      ? "Sync paused. The database could not be found. Check the sync URL."
      : "Sync paused because of a database error. Check the error log and try again.", retry: false }
}
