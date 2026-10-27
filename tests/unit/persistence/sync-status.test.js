const test = require("node:test")
const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const { PouchSyncService } = require("../../../packages/persistence/dist")
const { listenLiveSync } = require("../../../packages/persistence/dist/PouchSyncWatch")
const { compatibilityDatabase, eventually } = require("../../helpers/sync-compatibility")

test("an empty pull cannot declare sync idle before push has checked, or while push writes", () => {
  const chain = Object.assign(new EventEmitter(), { push: new EventEmitter(), pull: new EventEmitter() })
  const states = [], failures = []
  let current = true
  listenLiveSync(chain, () => current, () => {}, busy => states.push(busy), error => failures.push(error))
  chain.emit("paused")
  chain.pull.emit("paused")
  assert.deepEqual(states, [true])
  chain.push.emit("active")
  chain.pull.emit("paused")
  assert.equal(states.includes(false), false)
  chain.push.emit("paused")
  assert.equal(states.at(-1), false)
  chain.pull.emit("active")
  assert.equal(states.at(-1), true)
  const error = new Error("offline")
  chain.pull.emit("paused", error)
  assert.deepEqual(failures, [error])
  assert.equal(states.at(-1), true)
  current = false
  chain.pull.emit("paused")
  assert.equal(states.at(-1), true)
})

test("maintenance completion and starting live sync remain busy until both directions catch up", async () => {
  const chain = Object.assign(new EventEmitter(), { push: new EventEmitter(), pull: new EventEmitter(), cancel() {} })
  let liveStarted = false, maintenanceReads = 0
  const local = compatibilityDatabase({
    changes: async () => { maintenanceReads++; return { results: [], last_seq: 0 } },
    bulkDocs: async () => [],
    replicate: { from() { const pull = new EventEmitter(); queueMicrotask(() => pull.emit("complete")); return pull } },
    sync() { liveStarted = true; return chain }
  })
  const remote = compatibilityDatabase()
  const statuses = []
  const client = new PouchSyncService(local, () => {}, () => remote)
  client.onStatus(status => statuses.push(status))
  try {
    client.syncFrom("https://sync.test/once")
    await eventually(() => liveStarted)
    assert.ok(maintenanceReads > 0)
    assert.equal(statuses.some(status => status.state === "up-to-date"), false)
    chain.pull.emit("paused")
    assert.equal(statuses.at(-1).state, "syncing")
    chain.push.emit("active")
    chain.emit("change", { direction: "push", change: { docs: [{ _id: "sto_fixture" }] } })
    assert.equal(statuses.at(-1).state, "syncing")
    chain.push.emit("paused")
    assert.equal(statuses.at(-1).state, "up-to-date")
  } finally { client.syncFrom("") }
})
