import { epochSiblingUrl, readSyncEpoch, SYNC_COMPAT_ID, SYNC_EPOCH_ID, syncDatabaseName, syncDestination } from "@once/core"
import type { LocalDatabaseEpoch } from "./LocalDatabaseEpoch"

/**
 * Per-database metadata that replication must not carry: a marker copied
 * into a new epoch would point that database at itself.
 */
export function isSyncMetadataId(id: string | undefined): boolean {
  return id === SYNC_COMPAT_ID || id === SYNC_EPOCH_ID
}

interface EpochMarkerSource { get?(id: string): Promise<Record<string, unknown>> }

/** The epoch marker of `remote`, or null; a missing database rejects with `missingDatabase`. */
export async function readSyncEpochMarker(remote: string | EpochMarkerSource): Promise<unknown> {
  if (typeof remote === "string" || !remote.get) throw new Error("Sync epoch checks require a database transport")
  try {
    return await remote.get(SYNC_EPOCH_ID)
  } catch (error) {
    const { status, reason } = error as { status?: number; reason?: string }
    if (status !== 404) throw error
    if (!/database/i.test(String(reason))) return null
    throw Object.assign(new Error("The sync database could not be found"), { status, missingDatabase: true })
  }
}

/** During live sync: a marker appearing means the move started, so this session must end. */
export async function assertNoSyncEpoch(remote: EpochMarkerSource): Promise<void> {
  if (readSyncEpoch(await readSyncEpochMarker(remote))) throw new SyncEpochPendingError()
}

/** The database is between epochs; sync resumes by itself once the move is ready. */
export class SyncEpochPendingError extends Error {
  constructor() { super("Sync paused while the sync database is cleaned up. It resumes by itself.") }
}

/**
 * Reads the epoch marker of the database at a URL: the marker, null when
 * there is none, or a rejection. A rejection with `missingDatabase` means
 * the database itself is gone.
 */
export type SyncEpochReader = (url: string) => Promise<unknown>

const MAX_HOPS = 5

/** Follows epoch markers from `url` to the database that holds the data now. */
export async function followSyncEpoch(url: string, read: SyncEpochReader): Promise<string> {
  let current = url
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const epoch = readSyncEpoch(await read(current))
    if (!epoch) return current
    if (epoch.state === "preparing") throw new SyncEpochPendingError()
    const next = epochSiblingUrl(current, epoch.next)
    if (syncDestination(next) === syncDestination(current)) {
      throw new Error("Sync epoch metadata is damaged: the database points at itself")
    }
    current = next
  }
  throw new Error("Sync epoch metadata is damaged: the database moved too many times")
}

export type SyncEpochResolution =
  /** Replicate with this URL. */
  | { url: string }
  /** The local database was replaced; the app restarts on the new one. */
  | { restarting: true }

/**
 * Decides which remote this device replicates with, and moves its local
 * database first when that remote is a new epoch. The configured URL never
 * changes: it names the database a profile is bound to, and the markers
 * lead on from there. Never lets a local database replicate with an epoch
 * it was not rebuilt for, since it would hand the new database the losing
 * branches the move left behind.
 */
export async function resolveSyncEpoch(
  configuredUrl: string,
  read: SyncEpochReader,
  local: LocalDatabaseEpoch | undefined,
  progress: (copied: number) => void
): Promise<SyncEpochResolution> {
  const state = await local?.state() ?? {}
  if (state.retired) {
    // This database was replaced, but the switch did not take (a crash, or
    // the pointer was lost). Never sync it: finish switching instead.
    local?.activate(state.retired.database)
    local?.restart()
    return { restarting: true }
  }
  const moved = state.destination
  let effective: string
  try {
    effective = await followSyncEpoch(configuredUrl, read)
  } catch (error) {
    // The old database may be deleted once every device moved; a device
    // that already moved knows where to.
    if (!moved || !(error as { missingDatabase?: boolean }).missingDatabase) throw error
    effective = await followSyncEpoch(epochSiblingUrl(configuredUrl, syncDatabaseName(moved)), read)
  }
  const destination = syncDestination(effective)
  if (destination === (moved ?? syncDestination(configuredUrl))) return { url: effective }
  if (moved && destination === syncDestination(configuredUrl)) {
    throw new Error("Sync epoch metadata was removed. This device already moved to a newer database; restore the metadata before syncing.")
  }
  if (!local) throw new Error("Sync epoch metadata is unsupported here: this app cannot move its local data to the new database.")
  await local.rebuild(destination, progress)
  local.restart()
  return { restarting: true }
}
