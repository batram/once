import { syncDatabaseName } from "@once/core"
import { copyWinningRevisions, EpochCopyDatabase, EpochCopyDivergedError, EpochMigrationProgress, verifyWinningRevisions } from "./PouchEpochCopy"
import { PouchMaintenanceService } from "./PouchMaintenanceService"
import { epochLock, guardEpochWrites, withEpochDocumentWrites } from "./LocalEpochWrites"
import { reconcileEpoch } from "./ReconcileEpoch"
import { reviewEpochSetting } from "./EpochSettingReview"
import { resolveEpochSettingBatch } from "./EpochSettingBatch"
import type { SyncSettingResolution, SyncSettingReview } from "@once/core"

export interface EpochLocalDatabase extends EpochCopyDatabase {
  info(): Promise<{ update_seq?: unknown }>
  destroy?(): Promise<unknown>
}

/** Synchronous key-value storage shared by every context of the app: localStorage. */
export interface EpochPointerStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void | Promise<void>
}

interface Pointer { name: string; previous?: string }

export interface LocalEpochState {
  version?: number
  /** The remote destination this database was rebuilt for; absent for the original database. */
  destination?: string
  /** Configured URL destination whose epoch redirect this state remembers. */
  configuredDestination?: string
  /** Set on a database that was replaced: it must never sync again. */
  retired?: { database: string; destination: string }
  synchronized_at?: number
}

export const LOCAL_EPOCH_VERSION = 4

const POINTER_PREFIX = "once:local-database:"
const STATE_ID = "_local/once-sync-epoch"
const SYNC_FORMAT_ID = "_local/once-sync-format"
const MAX_PASSES = 5

function defaultStorage(): EpochPointerStorage | undefined {
  try {
    return (globalThis as { localStorage?: EpochPointerStorage }).localStorage
  } catch {
    return undefined
  }
}

function readPointer(base: string, storage: EpochPointerStorage | undefined): Pointer | null {
  try {
    const value = JSON.parse(storage?.getItem(POINTER_PREFIX + base) ?? "null") as Partial<Pointer> | null
    return typeof value?.name === "string" && value.name ? { name: value.name, ...(value.previous ? { previous: value.previous } : {}) } : null
  } catch {
    return null
  }
}

/**
 * The name to open the local database by. Every platform opens it
 * synchronously at startup, so the choice is a synchronous read. A lost
 * pointer opens the original database, which a move marked retired: it then
 * restores the pointer instead of syncing (see `resolveSyncEpoch`).
 */
export function activeLocalDatabaseName(base: string, storage = defaultStorage()): string {
  return readPointer(base, storage)?.name ?? base
}

/**
 * Opens a platform's local database by its active name, with the epoch
 * mover for it. Other windows restart when one of them switches databases.
 */
export function openLocalDatabase<T>(
  base: string,
  open: (name: string) => T,
  restart: () => void = () => (globalThis as { location?: { reload(): void } }).location?.reload(),
  storage = defaultStorage()
): { db: T; epoch: LocalDatabaseEpoch } {
  const name = activeLocalDatabaseName(base, storage)
  const db = open(name)
  const epoch = new LocalDatabaseEpoch(base, name, db as unknown as EpochLocalDatabase,
    (other) => open(other) as unknown as EpochLocalDatabase, restart, storage)
  epoch.watchSwitches()
  return { db, epoch }
}

/**
 * Moves this device's data to a fresh local database for a new sync epoch.
 * The rebuilt database holds reconciled winning revisions. Retired databases
 * remain as backups and durable routing records, even after a successful sync. The
 * pointer switch is the commit point: before it, a crash leaves the old
 * database in use and the copy resumes; after it, the new one opens.
 */
export class LocalDatabaseEpoch {
  private reviewRemote?: EpochCopyDatabase
  private reviewPrevious?: EpochCopyDatabase
  constructor(
    private readonly base: string,
    readonly name: string,
    private readonly db: EpochLocalDatabase,
    private readonly open: (name: string) => EpochLocalDatabase,
    private readonly restartApp: () => void,
    private readonly storage = defaultStorage()
  ) { guardEpochWrites(base, db) }

  async state(): Promise<LocalEpochState> {
    return (await readLocal(this.db, STATE_ID) ?? {}) as LocalEpochState
  }

  /** Older epoch records did not store the URL that led to their destination. */
  async rememberConfiguredDestination(destination: string): Promise<void> {
    await epochLock(this.base, async () => {
      const state = await this.state()
      if (state.destination && !state.configuredDestination) {
        await writeLocal(this.db, STATE_ID, { ...state, configuredDestination: destination })
      }
    })
  }

  async reviewSetting(id: string): Promise<SyncSettingReview> {
    if (!this.reviewRemote || (await this.state()).retired) throw new Error("Check sync again before reviewing settings")
    return reviewEpochSetting(this.db, this.reviewRemote, id)
  }

  async resolveSetting(choice: SyncSettingResolution, isCurrent = () => true): Promise<void> {
    await withEpochDocumentWrites(this.base, this.db, async direct => {
      if (!this.reviewRemote || (await this.state()).retired || activeLocalDatabaseName(this.base, this.storage) !== this.name) {
        throw new Error("The active database changed. Check sync again before reviewing settings.")
      }
      if (!this.reviewPrevious) throw new Error("Check sync again before reviewing settings")
      await resolveEpochSettingBatch({ ...direct, allDocs: this.db.allDocs.bind(this.db) }, this.reviewRemote,
        this.reviewPrevious, choice, isCurrent)
    })
  }

  /** Copies this database into the one for `destination`, verifies it, and switches to it. */
  async rebuild(destination: string, progress: EpochMigrationProgress = () => undefined,
    remote?: { canonical: EpochCopyDatabase; previous: EpochCopyDatabase; isCurrent?: () => boolean; configuredDestination?: string }): Promise<void> {
    if (typeof window !== "undefined" && !globalThis.navigator?.locks) throw new Error("Database migration requires Web Locks. Update this browser before moving; local data is retained.")
    await epochLock(this.base, async () => {
      this.reviewRemote = remote?.canonical
      this.reviewPrevious = remote?.previous
      if (remote?.isCurrent && !remote.isCurrent()) throw new Error("Sync session changed during epoch migration")
      // Another window may have moved this database while this one waited.
      const state = await this.state()
      if (state.retired || activeLocalDatabaseName(this.base, this.storage) !== this.name) return
      await this.assertPointerWritable()
      const targetName = `${this.base}@${syncDatabaseName(destination)}${state.destination && state.version !== LOCAL_EPOCH_VERSION ? `@v${LOCAL_EPOCH_VERSION}` : ""}`
      if (targetName === this.name) {
        throw new Error("The active local database has lost its epoch record. Restore this device from sync or backup; no database has been replaced.")
      }
      let target = this.open(targetName)
      const targetState = await readLocal(target, STATE_ID)
      if (targetState?.destination || targetState?.retired) throw new Error("The epoch target is already committed. Restore the local database pointer; no data has been replaced.")
      const staging = targetState?.staging as { source?: string; destination?: string } | undefined
      const checkpoint = await readLocal(target, "_local/once-epoch-copy")
      if (staging ? staging.source !== this.name || staging.destination !== destination :
        checkpoint?.source !== `local:${this.name}` && (await target.changes({ since: 0, limit: 1 })).results.length > 0) {
        throw new Error("The epoch target is not a recognized staging copy. No data has been replaced.")
      }
      const markStaging = () => writeLocal(target, STATE_ID, { staging: { source: this.name, destination } })
      await markStaging()
      let copied = 0
      let verified = false
      for (let pass = 0; pass < MAX_PASSES && !verified; pass++) {
        try {
          if (remote) {
            await reconcileEpoch(this.db, remote.canonical, remote.previous, target, destination, progress, remote.isCurrent)
            verified = true
            break
          }
          const result = await copyWinningRevisions(this.db, target, `local:${this.name}`, {
            onProgress: (step) => progress(copied + step.copied)
          })
          copied += result.copied
        } catch (error) {
          // An interrupted earlier rebuild copied a branch that has lost
          // since. Nobody uses the copy yet: start it over.
          if (!(error instanceof EpochCopyDivergedError) || !target.destroy) throw error
          await target.destroy()
          target = this.open(targetName)
          await markStaging()
          copied = 0
          continue
        }
        verified = (await verifyWinningRevisions(this.db, target)).ok
      }
      if (!verified) throw new Error("The local database changed repeatedly while it was moved; the move is retried")
      if (remote?.isCurrent && !remote.isCurrent()) throw new Error("Sync session changed during epoch migration")
      // The copy has no conflicts and nothing to compact: skip the scans an
      // empty checkpoint would start.
      await writeLocal(target, PouchMaintenanceService.COMPACTION_MARKER_ID, { completed_at: Date.now() })
      await writeLocal(target, PouchMaintenanceService.CONFLICT_CHECKPOINT_ID, { last_seq: (await target.info()).update_seq ?? 0 })
      const format = await readLocal(this.db, SYNC_FORMAT_ID)
      if (format) await writeLocal(target, SYNC_FORMAT_ID, { minSyncProtocol: format.minSyncProtocol })
      await writeLocal(target, STATE_ID, { destination, version: LOCAL_EPOCH_VERSION,
        ...(remote?.configuredDestination ? { configuredDestination: remote.configuredDestination } : {}) })
      await writeLocal(this.db, STATE_ID, { retired: { database: targetName, destination } })
      await this.activate(targetName)
    })
  }

  /** Opens `name` from the next start on. */
  async activate(name: string): Promise<void> {
    if (!this.storage) throw new Error("This app cannot switch its local database")
    await this.storage.setItem(POINTER_PREFIX + this.base, JSON.stringify({ name, previous: this.name }))
  }

  /** Restarts the app so it opens the active database. */
  restart(): void {
    this.restartApp()
  }

  /** Record an acknowledged sync, but keep the retired database and its durable routing marker. */
  async recordSynchronized(): Promise<void> {
    await epochLock(this.base, async () => {
      const state = await this.state()
      if (state.destination && !state.synchronized_at) await writeLocal(this.db, STATE_ID, { ...state, synchronized_at: Date.now() })
    })
  }

  /** Restarts this context when another one switched the database, so no window keeps writing to the old one. */
  watchSwitches(target: Pick<Window, "addEventListener"> | undefined = globalThis as unknown as Window): void {
    target?.addEventListener?.("storage", (event) => {
      if (event.key === POINTER_PREFIX + this.base && activeLocalDatabaseName(this.base, this.storage) !== this.name) this.restart()
    })
  }

  private async assertPointerWritable(): Promise<void> {
    if (!this.storage) throw new Error("This app cannot switch its local database")
    const probe = `${POINTER_PREFIX}${this.base}:probe`
    await this.storage.setItem(probe, "1")
    ;(this.storage as Partial<Storage>).removeItem?.(probe)
  }
}

async function readLocal(db: EpochCopyDatabase, id: string): Promise<Record<string, unknown> | null> {
  try {
    return await db.get(id)
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null
    throw error
  }
}

async function writeLocal(db: EpochCopyDatabase, id: string, values: Record<string, unknown>): Promise<void> {
  const existing = await readLocal(db, id)
  await db.put({ ...(existing ? { _rev: existing._rev } : {}), _id: id, ...values })
}
