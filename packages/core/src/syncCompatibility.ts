/** Increment only when shared data becomes incompatible with earlier clients. */
export const SYNC_PROTOCOL = 2
export const SYNC_COMPAT_ID = "once_sync_compat"
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
