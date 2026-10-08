import { LocalEventBus } from "./EventBus"
import { SyncStatus } from "./types"

/** Let an active replication batch finish before checking vault readiness. */
export function waitForActiveSync(status: () => SyncStatus, events: LocalEventBus, timeout = 20_000): Promise<void> {
  if (status().state !== "syncing") return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); unsubscribe(); resolve() }
    const unsubscribe = events.subscribe("syncStatusChanged", next => {
      if (next.state !== "syncing") finish()
    })
    const timer = setTimeout(finish, timeout)
  })
}
