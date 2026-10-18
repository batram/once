/**
 * Increment only when shared data becomes incompatible with earlier clients.
 * 3: the database may move to a new epoch (`once_sync_epoch`); clients that
 * cannot follow would push the losing branches the move leaves behind.
 */
export const SYNC_PROTOCOL = 3
export const SYNC_COMPAT_ID = "once_sync_compat"
/** Where a sync database announces that its data moves to a fresh database on the same server. */
export const SYNC_EPOCH_ID = "once_sync_epoch"
export interface SyncCompatibility { schema: 1; minSyncProtocol: number; minAppVersion?: string }
export interface SyncCompatibilityDetails { supportedSyncProtocol: number; requiredSyncProtocol: number; minAppVersion?: string }
export function readSyncCompatibility(raw: unknown): SyncCompatibility {
  const value = raw as Partial<SyncCompatibility> | null
  if (!value || value.schema !== 1 || !Number.isSafeInteger(value.minSyncProtocol) || Number(value.minSyncProtocol) < 1 ||
    (value.minAppVersion !== undefined && (typeof value.minAppVersion !== "string" || value.minAppVersion.length > 80))) throw new Error("Sync compatibility metadata is unsupported or damaged. Update Once or restore the database metadata before syncing.")
  return { schema: 1, minSyncProtocol: Number(value.minSyncProtocol), ...(value.minAppVersion ? { minAppVersion: value.minAppVersion } : {}) }
}
/** Inspect both legacy records and newer records before a replication session. */
export function requiredSyncProtocol(id: string, value: unknown): number {
  const data = value as { version?: number; addons?: Array<{ manifest?: { capabilities?: string[] } }> } | null
  if (id === "addon_vault" && Number(data?.version) >= 2) return Number(data?.version)
  if (id === "addons" && data?.addons?.some(entry => entry.manifest?.capabilities?.some(capability => capability === "ai" || capability === "search"))) return 2
  return 1
}

/**
 * A database epoch: "preparing" while an operator copies the winning
 * revisions into `next`, "ready" once clients should move there. `next` is a
 * database name, never a URL, so the marker can only point at a sibling on
 * the same server, reached with the same credentials.
 */
export interface SyncEpoch { schema: 1; state: "preparing" | "ready"; next: string }

/** CouchDB's database name rule, without `/`: a sibling, not a nested path. */
const DATABASE_NAME = /^[a-z][a-z0-9_$()+-]{0,237}$/

/** The marker, or null when the database has none. Throws when it is damaged. */
export function readSyncEpoch(raw: unknown): SyncEpoch | null {
  const value = raw as (Partial<SyncEpoch> & { _deleted?: boolean }) | null | undefined
  if (!value || value._deleted) return null
  if (value.schema !== 1 || (value.state !== "preparing" && value.state !== "ready") ||
    typeof value.next !== "string" || !DATABASE_NAME.test(value.next)) {
    throw new Error("Sync epoch metadata is unsupported or damaged. Update Once or restore the database metadata before syncing.")
  }
  return { schema: 1, state: value.state, next: value.next }
}

/** `url` with its last path segment replaced by `name`, credentials kept. */
export function epochSiblingUrl(url: string, name: string): string {
  if (!DATABASE_NAME.test(name)) throw new Error("Invalid sync database name")
  const parsed = new URL(url)
  const segments = parsed.pathname.replace(/\/+$/, "").split("/")
  segments[segments.length - 1] = name
  parsed.pathname = `${segments.join("/")}/`
  return parsed.href
}

/** The database name a sync URL or destination ends in. */
export function syncDatabaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/\/+$/, "").split("/").pop() ?? "")
}
