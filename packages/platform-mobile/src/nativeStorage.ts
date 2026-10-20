import PouchDB from "pouchdb-browser"
import { Capacitor } from "@capacitor/core"
import { isSyncMetadataId, syncDestination } from "@once/core"
import {
  activeLocalDatabaseName, EpochCopyDatabase, EpochPointerStorage, followSyncEpoch,
  LOCAL_EPOCH_VERSION, LOCAL_POUCH_OPTIONS, openLocalDatabase, readSyncEpochMarker,
  verifyWinningRevisions, protectRemoteAttachments
} from "@once/persistence"
import { NativeLevel } from "./NativeLevel"
import { nativePouchAdapter } from "./nativePouchAdapter"
import { nativeFetch } from "./nativeFetch"

const BASE = "once_mobile_native_v1"
const POINTER = `once:local-database:${BASE}`
const READY = "_local/once-native-storage-v1"
let nativePointer: EpochPointerStorage | undefined

PouchDB.plugin(nativePouchAdapter(NativeLevel))

export function openMobileDatabase() {
  if (Capacitor.getPlatform() !== "android") {
    return openLocalDatabase("once_mobile_v1", name => new PouchDB(name, LOCAL_POUCH_OPTIONS))
  }
  if (!nativePointer) throw new Error("Native storage must be prepared before starting Once")
  return openLocalDatabase(BASE, name => new PouchDB(name, { ...LOCAL_POUCH_OPTIONS, adapter: "native-sqlite" }), undefined, nativePointer)
}

async function optionalDocument(db: PouchDB.Database, id: string): Promise<Record<string, unknown> | null> {
  try { return await db.get(id) } catch (error) {
    if ((error as { status?: number }).status === 404) return null
    throw error
  }
}

/** Block all app writes until a native import/recovery is verified and committed. */
export async function prepareMobileDatabase(syncUrl: string | (() => Promise<string>), progress: (message: string) => void): Promise<void> {
  if (Capacitor.getPlatform() !== "android") return
  let pointer = String((await NativeLevel.execute({ operation: "readPointer" })).value || "")
  if (pointer) {
    const parsed = JSON.parse(pointer) as { name?: string }
    if (!parsed.name?.startsWith(BASE)) throw new Error("Invalid native database pointer; recovery is required")
  }
  const storage: EpochPointerStorage = {
    getItem: key => key === POINTER ? pointer || null : null,
    async setItem(key, value) {
      if (key.endsWith(":probe")) {
        await NativeLevel.execute({ operation: "writePointer", value: pointer })
        return
      }
      if (key !== POINTER) throw new Error("Unexpected native pointer key")
      await NativeLevel.execute({ operation: "writePointer", value })
      pointer = value
    }
  }
  const name = activeLocalDatabaseName(BASE, storage)
  const target = new PouchDB(name, { ...LOCAL_POUCH_OPTIONS, adapter: "native-sqlite" })
  let source: PouchDB.Database | undefined
  try {
    // Future epoch copies do not replicate local docs, but do commit their own epoch record.
    const [ready, epoch] = await Promise.all([
      optionalDocument(target, READY), optionalDocument(target, "_local/once-sync-epoch")
    ])
    if (pointer && (ready || epoch?.destination || epoch?.retired)) {
      nativePointer = storage
      return
    }
    if (pointer) throw new Error("Native database metadata is missing; refusing to initialize over existing state")
    progress("Preparing durable storage…")
    const legacyName = activeLocalDatabaseName("once_mobile_v1")
    const databases = await indexedDB.databases()
    const hasLegacy = databases.some(database => database.name === `_pouch_${legacyName}`)
    // Normal startup and local migration do not need the remote recovery URL.
    const recoveryUrl = hasLegacy ? "" : typeof syncUrl === "function" ? await syncUrl() : syncUrl
    let destination: string | undefined
    let epochVersion: unknown = LOCAL_EPOCH_VERSION
    if (hasLegacy) {
      source = new PouchDB(legacyName, LOCAL_POUCH_OPTIONS)
      const oldEpoch = await optionalDocument(source, "_local/once-sync-epoch")
      if (oldEpoch?.retired) throw new Error("The old database is retired; restore its active pointer before importing")
      destination = oldEpoch?.destination as string | undefined
      // Moving adapters is not an epoch upgrade. Older data must still pass reconciliation.
      epochVersion = oldEpoch?.version
      progress("Copying existing data to durable storage…")
    } else if (recoveryUrl) {
      progress("Recovering data from sync into durable storage…")
      const effective = await followSyncEpoch(recoveryUrl, async url => {
        const remote = new PouchDB(url, { fetch: nativeFetch, skip_setup: true })
        try { return await readSyncEpochMarker(remote as unknown as EpochCopyDatabase) } finally { await remote.close() }
      })
      source = protectRemoteAttachments(new PouchDB(effective, { fetch: nativeFetch, skip_setup: true }))
      destination = syncDestination(effective)
    } else if (localStorage.getItem("once:local-database:once_mobile_v1")) {
      throw new Error("The old database is missing and sync is not configured; recovery is required")
    }
    if (source) {
      let verified = false
      for (let attempt = 0; attempt < 3 && !verified; attempt++) {
        // Target-only checkpoints: migration never changes the source or server.
        await PouchDB.replicate(source, target, {
          batch_size: 500, batches_limit: 1, checkpoint: "target",
          selector: { _id: { $nin: ["once_sync_compat", "once_sync_epoch", "_design/once-epoch-freeze"] } }
        })
        progress("Verifying restored revisions and attachments…")
        const report = await verifyWinningRevisions(source as unknown as EpochCopyDatabase, target as unknown as EpochCopyDatabase,
          { exclude: isSyncMetadataId })
        if (report.conflicted.length || report.unresolved.length) {
          throw new Error("Resolve database conflicts before importing native storage; all source data is retained")
        }
        verified = report.ok
      }
      if (!verified) throw new Error("Recovery verification did not match; the app has not started syncing")
      const format = hasLegacy ? await optionalDocument(source, "_local/once-sync-format") : null
      if (format) {
        const current = await optionalDocument(target, "_local/once-sync-format")
        await target.put({ ...format, _rev: current?._rev } as PouchDB.Core.PutDocument<Record<string, unknown>>)
      }
    }
    if (destination) {
      const current = await optionalDocument(target, "_local/once-sync-epoch")
      await target.put({ _id: "_local/once-sync-epoch", ...(current ? { _rev: String(current._rev) } : {}), destination,
        ...(epochVersion === undefined ? {} : { version: epochVersion }) })
    }
    const current = await optionalDocument(target, READY)
    await target.put({ _id: READY, ...(current ? { _rev: String(current._rev) } : {}), version: 1, imported: Boolean(source) })
    await storage.setItem(POINTER, JSON.stringify({ name }))
    nativePointer = storage
  } finally {
    await source?.close()
    await target.close()
  }
}
