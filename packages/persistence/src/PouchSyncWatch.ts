import { SYNC_COMPAT_ID, SYNC_EPOCH_ID } from "@once/core"
import type { PouchSyncDatabase, PouchEventChain } from "./PouchSyncService"

/** Long-poll only metadata. Ordinary replication is independently cancellable. */
export function watchSyncCompatibility(remote: PouchSyncDatabase, check: () => Promise<void>, failed: (error: unknown) => void): () => void {
  let stopped = false
  if (!remote.changes) throw new Error("Sync compatibility monitoring is unavailable")
  const request = remote.changes({ since: 0, live: true, retry: false, doc_ids: [SYNC_COMPAT_ID, SYNC_EPOCH_ID], include_docs: true }) as unknown as PouchEventChain
  if (!request.on) throw new Error("Sync compatibility monitoring is unavailable")
  request.on("change", () => { if (!stopped) void check().catch(error => { if (!stopped) failed(error) }) })
    .on("error", error => { if (!stopped) failed(error) })
  return () => { stopped = true; request.cancel?.() }
}

/** Ignore events queued by a cancelled transport, including optimistic 'paused' events. */
export function listenLiveSync(chain: PouchEventChain, current: () => boolean, changed: (event: unknown) => void,
  status: (busy: boolean) => void, failed: (error: unknown) => void): void {
  chain.on("change", event => { if (current()) changed(event) })
    .on("active", () => { if (current()) status(true) })
    .on("paused", error => { if (current()) { if (error) failed(error); else status(false) } })
    .on("error", error => { if (current()) failed(error) })
    .on("denied", error => { if (current()) failed(error) })
}
