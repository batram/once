import {
  DeviceIdentity,
  SyncDestinationBinding,
  SyncGate,
  TabDocRepository,
  TabSyncService,
  tabSyncTestTiming
} from "@once/app/tabsync"

const TEST_TIMING_KEY = "once:e2e:tabsync-timing"
import { installTabSyncSending } from "./tabSyncSending"
import type { ListStorePort, SyncConsentPort } from "@once/app"
import { couchHttpTabDocs } from "@once/persistence"
import { createFirefoxSyncConsent, deviceName, WebExtSecretStorage, WebExtSyncStorage } from "@once/platform-webext/backgroundPorts"
import { installTabSyncCapture } from "./tabSyncCapture"
import { installTabSyncTimes } from "./tabSyncTimes"

const HEARTBEAT_ALARM = "once-tabsync-heartbeat"
const RETRY_ALARM = "once-tabsync-retry"
/** Every thirty seconds while a selected or playing tab has a position to keep up with. */
const SAMPLE_ALARM = "once-tabsync-sample"

/**
 * Publishes this browser's tabs from the background, so they are shared
 * whether or not a Once panel is open. The background cannot keep PouchDB
 * replication running, so it writes straight to CouchDB; every request
 * passes the same database binding and consent checks as the panel's
 * replication, and a URL replaced in the meantime ends the connection
 * instead of redirecting work queued for the old one. Listeners are
 * registered synchronously so the browser can wake the background for them.
 */
export function installTabSyncBackground(api: typeof browser, target: "chrome" | "firefox"): void {
  const source = { ...installTabSyncTimes(api), captureThumbnail: installTabSyncCapture(api) }
  const secrets = new WebExtSecretStorage(api)
  const syncStorage = new WebExtSyncStorage(api)
  const consent: SyncConsentPort | undefined = target === "firefox" ? createFirefoxSyncConsent(api) : undefined
  const gate = new SyncGate(new SyncDestinationBinding(secrets, "browser"), consent, localPouchExists)
  const identity = new DeviceIdentity(secrets, target, deviceName(target))
  let connection = 0
  let current: { service: TabSyncService; generation: number } | null = null
  const sending = installTabSyncSending(api, target, () => current?.service ?? null)

  const connect = async () => {
    const generation = ++connection
    current?.service.dispose()
    current = null
    const url = await syncStorage.getSyncUrl()
    if (!url.trim() || generation !== connection) return
    const refusal = await gate.check(url, "external").catch(() => "unavailable")
    if (refusal || generation !== connection) return
    // Each request re-checks: consent can be withdrawn and the URL replaced at any time.
    const allowed = async () => generation === connection && !await gate.check(url, "external").catch(() => "unavailable")
    const docs = couchHttpTabDocs(url, fetch.bind(globalThis), allowed)
    // Only an end-to-end test writes this key, to wait seconds rather than the real intervals.
    const timing = tabSyncTestTiming((await api.storage.local.get(TEST_TIMING_KEY))[TEST_TIMING_KEY])
    const service = new TabSyncService({
      identity, repository: new TabDocRepository(docs), listStore: sharedSettings(docs), source,
      appVersion: api.runtime.getManifest().version,
      timing,
      syncActive: () => generation === connection,
      samplingNeeded: (needed) => {
        if (needed) void api.alarms.create(SAMPLE_ALARM, { periodInMinutes: 0.5 })
        else void api.alarms.clear(SAMPLE_ALARM)
      },
      changed: () => sending.changed(),
      reportError: (operation, error) => {
        console.warn(`Tab sync ${operation} failed; retrying later`, error)
        void api.alarms.create(RETRY_ALARM, { delayInMinutes: 1 })
      }
    })
    current = { service, generation }
    await service.start()
  }
  const restart = () => void connect().catch((error) => console.error("Tab sync could not start", error))

  api.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && Object.hasOwn(changes, "sync_url")) restart()
    // A panel changed this device's options or identity.
    else if (area === "local" && Object.keys(changes).some((key) => ["secret:once:device-identity", "secret:once:tabsync-options"].includes(key))) {
      identity.invalidate()
      current?.service.optionsChangedElsewhere()
    }
  })
  consent?.onChanged(restart)
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SAMPLE_ALARM) void current?.service.sampleNow()
    else if (alarm.name === HEARTBEAT_ALARM || alarm.name === RETRY_ALARM) {
      // Without a change feed here, the heartbeat is also when sent tabs are noticed.
      if (current) { current.service.publishSoon(); current.service.refreshSoon(); current.service.maintainSoon() }
      else restart()
    }
  })
  void api.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 10 })
  restart()
}

/** The synced tab sync settings, read straight from the database. */
function sharedSettings(docs: ReturnType<typeof couchHttpTabDocs>): ListStorePort {
  return {
    get: async <T>(id: string, fallback: T) => ((await docs.get(id).catch(() => null))?.list as T | undefined) ?? fallback,
    set: async () => { throw new Error("Shared settings are changed from a panel") }
  }
}

/**
 * Whether the panel's database exists, which an earlier connection may have
 * filled: then a browser-synced URL is not trusted until the user confirms it.
 */
async function localPouchExists(): Promise<boolean> {
  const factory = (globalThis as { indexedDB?: IDBFactory & { databases?(): Promise<Array<{ name?: string }>> } }).indexedDB
  if (!factory?.databases) return true
  const names = (await factory.databases()).map((entry) => entry.name ?? "")
  return names.some((name) => name.endsWith("once_db"))
}
