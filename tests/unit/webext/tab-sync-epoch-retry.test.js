const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const { createRequire } = require("node:module")
const backgroundRequire = createRequire(require.resolve("../../../packages/webext-shell/dist/tabSyncBackground"))
const { SyncEpochPendingError } = require("../../../packages/persistence/dist")

test("background reconnect keeps retrying through preparing and remembers the ready destination", async t => {
  const services = [], alarms = new Map(), values = new Map([["secret:once:sync-destination", "https://sync.test/once"]])
  let onAlarm, onStorage, preparing = false, ready = false, oldGone = false
  const requests = []
  const api = {
    storage: {
      local: { get: async key => ({ [key]: values.get(key) }), set: async data => Object.entries(data).forEach(([key, value]) => values.set(key, value)), remove: async key => values.delete(key) },
      sync: { get: async () => ({ sync_url: "https://sync.test/once" }) },
      onChanged: { addListener(listener) { onStorage = listener } }
    },
    alarms: { create: async (name, options) => alarms.set(name, options), clear: async name => alarms.delete(name), onAlarm: { addListener(listener) { onAlarm = listener } } },
    runtime: { getManifest: () => ({ version: "test" }) }
  }
  class Service {
    constructor(deps) { this.deps = deps; services.push(this) }
    async start() {}
    dispose() { this.disposed = true }
  }
  const customRequire = id => {
    if (id === "@once/app/tabsync") return { ...backgroundRequire(id), TabSyncService: Service }
    if (id === "@once/platform-webext/backgroundPorts") return { ...backgroundRequire(id), deviceName: () => "Test" }
    if (id === "./tabSyncTimes") return { installTabSyncTimes: () => ({}) }
    if (id === "./tabSyncCapture") return { installTabSyncCapture: () => () => null }
    if (id === "./tabSyncSending") return { installTabSyncSending: () => ({ changed() {} }) }
    return backgroundRequire(id)
  }
  const exports = {}
  // Run the actual connection coordinator with inert browser listeners and no real network.
  new Function("require", "exports", fs.readFileSync(require.resolve("../../../packages/webext-shell/dist/tabSyncBackground"), "utf8"))(customRequire, exports)
  t.mock.method(globalThis, "fetch", async url => {
    const parsed = new URL(url), id = parsed.pathname.split("/").pop(), old = parsed.pathname.startsWith("/once/")
    requests.push(parsed.pathname)
    if (old && oldGone) throw Error("The old database must not be contacted")
    let doc = null
    if (id === "once_sync_compat") doc = { schema: 1, minSyncProtocol: 4 }
    if (id === "once_sync_epoch" && old && (preparing || ready)) doc = { schema: 1, state: ready ? "ready" : "preparing", next: "once_e2" }
    return new Response(JSON.stringify(doc ?? { error: "not_found", reason: "missing" }), { status: doc ? 200 : 404 })
  })
  const flush = async () => { for (let i = 0; i < 80; i++) await new Promise(resolve => setImmediate(resolve)) }
  exports.installTabSyncBackground(api, "chrome")
  await flush()
  assert.equal(services.length, 1)
  preparing = true
  await assert.rejects(services[0].deps.repository.db.put({ _id: "tsend_test" }), SyncEpochPendingError)
  assert.equal(services[0].disposed, true)
  for (let retry = 0; retry < 2; retry++) {
    assert.equal(alarms.get("once-tabsync-retry").delayInMinutes, 1)
    alarms.delete("once-tabsync-retry")
    onAlarm({ name: "once-tabsync-retry" })
    await flush()
  }
  assert.equal(alarms.get("once-tabsync-retry").delayInMinutes, 1)
  ready = true
  onAlarm({ name: "once-tabsync-retry" })
  await flush()
  assert.equal(services.length, 2)
  requests.length = 0
  oldGone = true
  onStorage({ sync_url: {} }, "sync")
  await flush()
  assert.equal(services.length, 3)
  assert.ok(requests.every(url => url.startsWith("/once_e2/")))
})
