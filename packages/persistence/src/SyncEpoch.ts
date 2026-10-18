import { epochSiblingUrl, readSyncEpoch, SYNC_EPOCH_ID, syncDatabaseName, syncDestination } from "@once/core"
import { LOCAL_EPOCH_VERSION, type LocalDatabaseEpoch } from "./LocalDatabaseEpoch"
import type { EpochCopyDatabase } from "./PouchEpochCopy"

export { isSyncMetadataId } from "@once/core"

interface EpochMarkerSource { get?(id: string): Promise<Record<string, unknown>> }

/** The epoch marker of `remote`, or null; a missing database rejects. */
export async function readSyncEpochMarker(remote: string | EpochMarkerSource): Promise<unknown> {
  if (typeof remote === "string" || !remote.get) throw new Error("Sync epoch checks require a database transport")
  try {
    return await remote.get(SYNC_EPOCH_ID)
  } catch (error) {
    const { status, reason } = error as { status?: number; reason?: string }
    if (status === 404 && !/database/i.test(String(reason))) return null
    throw error
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

/** Reads the epoch marker of the database at a URL: the marker, null when there is none, or a rejection. */
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
 *
 * A device that already moved starts from the database it moved to and
 * never contacts the old one again: the old one may be deleted, and the
 * first request of a PouchDB transport would try to create it.
 */
export async function resolveSyncEpoch(
  configuredUrl: string,
  read: SyncEpochReader,
  local: LocalDatabaseEpoch | undefined,
  progress: (copied: number) => void,
  open?: (url: string) => Promise<EpochCopyDatabase>,
  isCurrent = () => true
): Promise<SyncEpochResolution> {
  const state = await local?.state() ?? {}
  if (!isCurrent()) throw new Error("Sync session changed during epoch migration")
  if (state.version !== undefined && state.version > LOCAL_EPOCH_VERSION) throw new Error("Local epoch metadata is unsupported. Update Once before syncing.")
  if (state.retired) {
    // This database was replaced, but the switch did not take (a crash, or
    // the pointer was lost). Never sync it: finish switching instead.
    local?.activate(state.retired.database)
    local?.restart()
    return { restarting: true }
  }
  const start = state.destination ? epochSiblingUrl(configuredUrl, syncDatabaseName(state.destination)) : configuredUrl
  const effective = await followSyncEpoch(start, url => {
    if (!isCurrent()) throw new Error("Sync session changed during epoch migration")
    return read(url)
  })
  if (!isCurrent()) throw new Error("Sync session changed during epoch migration")
  const destination = syncDestination(effective)
  const legacy = Boolean(state.destination) && state.version !== LOCAL_EPOCH_VERSION
  if (destination === syncDestination(start) && !legacy) return { url: effective }
  if (!local) throw new Error("Sync epoch metadata is unsupported here: this app cannot move its local data to the new database.")
  if (!open) throw new Error("Epoch reconciliation requires a database transport; local data is retained")
  await local.rebuild(destination, progress, { canonical: await open(effective), previous: await open(legacy ? configuredUrl : start), isCurrent })
  local.restart()
  return { restarting: true }
}
