import { syncDatabaseName } from "@once/core"
import { copyWinningRevisions, EpochCopyDatabase, EpochCopyDivergedError, verifyWinningRevisions } from "./PouchEpochCopy"
import { PouchMaintenanceService } from "./PouchMaintenanceService"

export interface EpochLocalDatabase extends EpochCopyDatabase {
  info(): Promise<{ update_seq?: unknown }>
  destroy?(): Promise<unknown>
}

/** Synchronous key-value storage shared by every context of the app: localStorage. */
export interface EpochPointerStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface Pointer { name: string; previous?: string }

export interface LocalEpochState {
  /** The remote destination this database was rebuilt for; absent for the original database. */
  destination?: string
  /** Set on a database that was replaced: it must never sync again. */
  retired?: { database: string; destination: string }
}

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
  restart: () => void = () => (globalThis as { location?: { reload(): void } }).location?.reload()
): { db: T; epoch: LocalDatabaseEpoch } {
  const name = activeLocalDatabaseName(base)
  const db = open(name)
  const epoch = new LocalDatabaseEpoch(base, name, db as unknown as EpochLocalDatabase,
    (other) => open(other) as unknown as EpochLocalDatabase, restart)
  epoch.watchSwitches()
  return { db, epoch }
}

/**
 * Moves this device's data to a fresh local database for a new sync epoch.
 * The rebuilt database holds only the winning revisions, and nothing is lost
 * from the old one until the first successful sync with the new remote. The
 * pointer switch is the commit point: before it, a crash leaves the old
 * database in use and the copy resumes; after it, the new one opens.
 */
export class LocalDatabaseEpoch {
  constructor(
    private readonly base: string,
    readonly name: string,
    private readonly db: EpochLocalDatabase,
    private readonly open: (name: string) => EpochLocalDatabase,
    private readonly restartApp: () => void,
    private readonly storage = defaultStorage()
  ) {}

  async state(): Promise<LocalEpochState> {
    return (await readLocal(this.db, STATE_ID) ?? {}) as LocalEpochState
  }

  /** Copies this database into the one for `destination`, verifies it, and switches to it. */
  async rebuild(destination: string, progress: (copied: number) => void = () => undefined): Promise<void> {
    await withLock(`once-local-database-epoch:${this.base}`, async () => {
      // Another window may have moved this database while this one waited.
      if ((await this.state()).retired || activeLocalDatabaseName(this.base, this.storage) !== this.name) return
      this.assertPointerWritable()
      const targetName = `${this.base}@${syncDatabaseName(destination)}`
      let target = this.open(targetName)
      let copied = 0
      let verified = false
      for (let pass = 0; pass < MAX_PASSES && !verified; pass++) {
        try {
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
          copied = 0
          continue
        }
        verified = (await verifyWinningRevisions(this.db, target)).ok
      }
      if (!verified) throw new Error("The local database changed repeatedly while it was moved; the move is retried")
      // The copy has no conflicts and nothing to compact: skip the scans an
      // empty checkpoint would start.
      await writeLocal(target, PouchMaintenanceService.COMPACTION_MARKER_ID, { completed_at: Date.now() })
      await writeLocal(target, PouchMaintenanceService.CONFLICT_CHECKPOINT_ID, { last_seq: (await target.info()).update_seq ?? 0 })
      const format = await readLocal(this.db, SYNC_FORMAT_ID)
      if (format) await writeLocal(target, SYNC_FORMAT_ID, { minSyncProtocol: format.minSyncProtocol })
      await writeLocal(target, STATE_ID, { destination })
      await writeLocal(this.db, STATE_ID, { retired: { database: targetName, destination } })
      this.activate(targetName)
    })
  }

  /** Opens `name` from the next start on. */
  activate(name: string): void {
    if (!this.storage) throw new Error("This app cannot switch its local database")
    this.storage.setItem(POINTER_PREFIX + this.base, JSON.stringify({ name, previous: this.name }))
  }

  /** Restarts the app so it opens the active database. */
  restart(): void {
    this.restartApp()
  }

  /** After the new epoch synced: removes the database this one replaced. */
  async forgetPrevious(): Promise<void> {
    const pointer = readPointer(this.base, this.storage)
    if (!pointer?.previous || pointer.name !== this.name || !(await this.state()).destination) return
    await this.open(pointer.previous).destroy?.()
    this.storage?.setItem(POINTER_PREFIX + this.base, JSON.stringify({ name: pointer.name }))
  }

  /** Restarts this context when another one switched the database, so no window keeps writing to the old one. */
  watchSwitches(target: Pick<Window, "addEventListener"> | undefined = globalThis as unknown as Window): void {
    target?.addEventListener?.("storage", (event) => {
      if (event.key === POINTER_PREFIX + this.base && activeLocalDatabaseName(this.base, this.storage) !== this.name) this.restart()
    })
  }

  private assertPointerWritable(): void {
    if (!this.storage) throw new Error("This app cannot switch its local database")
    const probe = `${POINTER_PREFIX}${this.base}:probe`
    this.storage.setItem(probe, "1")
    ;(this.storage as Partial<Storage>).removeItem?.(probe)
  }
}

/** Serializes across windows with Web Locks where they exist; within this context otherwise. */
function withLock(name: string, work: () => Promise<void>): Promise<void> {
  const locks = (globalThis as { navigator?: { locks?: { request(name: string, callback: () => Promise<void>): Promise<void> } } }).navigator?.locks
  if (locks?.request) return locks.request(name, work)
  const run = (queues.get(name) ?? Promise.resolve()).then(work, work)
  queues.set(name, run.catch(() => undefined))
  return run
}
const queues = new Map<string, Promise<void>>()

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
