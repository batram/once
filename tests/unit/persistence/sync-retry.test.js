const test = require("node:test")
const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const { PouchSyncService } = require("../../../packages/persistence/dist")
const { syncFailure } = require("../../../packages/persistence/dist/SyncFailure")
const { SyncCompatibilityError } = require("../../../packages/persistence/dist/PouchSyncCompatibility")
const { compatibilityDatabase } = require("../../helpers/sync-compatibility")

// The service hashes the sync URL with WebCrypto, which runs on the libuv
// thread pool: under a loaded full suite it outlasted flush() and the
// assertions read a state still settling. Hashed in-process, it is only
// microtasks, which flush() does wait for.
const { createHash } = require("node:crypto")
crypto.subtle.digest = async (_algorithm, data) => Uint8Array.from(createHash("sha256").update(data).digest()).buffer

async function flush() {
  for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve))
}

test("only proven protocol mismatches are compatibility errors; transport and server failures retry", () => {
  for (const error of [new TypeError("Failed to fetch"), new TypeError("Content-Length header of network response exceeds response Body."),
    new Error("NetworkError when attempting to fetch resource."), new DOMException("Aborted", "AbortError"),
    ...[0, 408, 409, 425, 429, 500, 502, 503, 504].map(status => ({ status, message: "network failed" }))]) {
    assert.equal(syncFailure(error).retry, true)
    assert.equal(syncFailure(error).operation, "sync.retry")
  }
  for (const status of [400, 401, 403, 404, 413]) {
    assert.equal(syncFailure({ status, message: "Failed to fetch" }).retry, false)
    assert.notEqual(syncFailure({ status }).operation, "sync.compatibility")
  }
  assert.equal(syncFailure(new Error("unexpected local failure")).retry, false)
  assert.equal(syncFailure(new SyncCompatibilityError("metadata was removed")).operation, "sync.metadata")
  assert.equal(syncFailure(new Error("Sync compatibility metadata is unsupported or damaged.")).operation, "sync.metadata")
  assert.equal(syncFailure(new SyncCompatibilityError("Update Once", { supportedSyncProtocol: 1, requiredSyncProtocol: 2 })).operation, "sync.compatibility")
  assert.notEqual(syncFailure(new SyncCompatibilityError("Unknown metadata", { supportedSyncProtocol: 2, requiredSyncProtocol: 2 })).operation, "sync.compatibility")
})

test("retries back off, stay quiet, and recheck the protocol before replication", async t => {
  const warnings = t.mock.method(console, "warn", () => {})
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let reads = 0, pulls = 0, offline = true
  const local = compatibilityDatabase({ replicate: { from() { pulls++; throw new Error("must not replicate") } } })
  const remote = compatibilityDatabase()
  const get = remote.get
  remote.get = (...args) => { reads++; return offline ? Promise.reject(new TypeError("Failed to fetch")) : get(...args) }
  const statuses = [], diagnostics = []
  const client = new PouchSyncService(local, () => {}, () => remote)
  client.onStatus(value => statuses.push(value))
  client.onDiagnostic(value => diagnostics.push(value))
  try {
    client.syncFrom("https://sync.test/once")
    await flush()
    assert.equal(statuses.at(-1).state, "retrying")
    t.mock.timers.tick(2999); await flush(); assert.equal(reads, 1)
    t.mock.timers.tick(1); await flush(); assert.equal(reads, 2)
    t.mock.timers.tick(5999); await flush(); assert.equal(reads, 2)
    t.mock.timers.tick(1); await flush(); assert.equal(reads, 3)
    assert.equal(diagnostics.length, 0)
    assert.match(warnings.mock.calls[2].arguments[0], /"retryInMs":12000/)
    offline = false
    await remote.put({ _id: "once_sync_compat", schema: 1, minSyncProtocol: 5 })
    t.mock.timers.tick(12000); await flush()
    assert.equal(statuses.at(-1).state, "update-required")
    assert.equal(diagnostics[0].operation, "sync.compatibility")
    assert.equal(pulls, 0)
    const before = reads
    t.mock.timers.tick(120000); await flush(); assert.equal(reads, before)
  } finally { client.syncFrom("") }
})

test("disabling sync cancels retries; authorization failures require action", async t => {
  t.mock.method(console, "warn", () => {})
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let attempts = 0, failure = new TypeError("Failed to fetch")
  const remote = compatibilityDatabase()
  remote.get = async () => { attempts++; throw failure }
  const statuses = [], diagnostics = []
  const client = new PouchSyncService(compatibilityDatabase(), () => {}, () => remote)
  client.onStatus(value => statuses.push(value))
  client.onDiagnostic(value => diagnostics.push(value))
  client.syncFrom("https://sync.test/once"); await flush()
  client.syncFrom("")
  t.mock.timers.tick(120000); await flush()
  assert.equal(attempts, 1)
  assert.equal(statuses.at(-1).state, "disabled")
  failure = { status: 401, name: "unauthorized" }
  client.syncFrom("https://sync.test/once"); await flush()
  assert.equal(statuses.at(-1).state, "error")
  assert.equal(diagnostics[0].operation, "sync.authorization")
  t.mock.timers.tick(120000); await flush()
  assert.equal(attempts, 2)
  client.syncFrom("")
})

test("both live-feed failures reconnect without notifications and stale events stay cancelled", async t => {
  const warnings = t.mock.method(console, "warn", () => {})
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const watches = [], live = []
  const chain = () => {
    const value = new EventEmitter()
    value.cancel = () => { value.cancelled = true }
    return value
  }
  const remote = compatibilityDatabase({ changes: () => { const value = chain(); watches.push(value); return value } })
  const local = compatibilityDatabase({
    replicate: { from() { const value = chain(); queueMicrotask(() => value.emit("complete")); return value } },
    sync() { const value = chain(); live.push(value); queueMicrotask(() => value.emit("paused")); return value }
  })
  const client = new PouchSyncService(local, () => {}, () => remote)
  const statuses = [], diagnostics = []
  client.onStatus(value => statuses.push(value))
  client.onDiagnostic(value => diagnostics.push(value))
  client.syncFrom("https://sync.test/once")
  await flush()
  try {
    assert.equal(statuses.at(-1).state, "up-to-date")
    watches[0].emit("error", new TypeError("Content-Length header of network response exceeds response Body."))
    assert.equal(statuses.at(-1).state, "retrying")
    assert.equal(live[0].cancelled, true)
    live[0].emit("paused")
    assert.equal(statuses.at(-1).state, "retrying")
    t.mock.timers.tick(3000); await flush()
    assert.equal(statuses.at(-1).state, "up-to-date")
    live[1].emit("error", new TypeError("Failed to fetch"))
    assert.equal(statuses.at(-1).state, "retrying")
    assert.equal(watches[1].cancelled, true)
    t.mock.timers.tick(6000); await flush()
    assert.equal(statuses.at(-1).state, "up-to-date")
    assert.equal(diagnostics.length, 0)
    t.mock.timers.tick(30000); await flush()
    live[2].emit("error", new TypeError("Failed to fetch"))
    assert.match(warnings.mock.calls.at(-1).arguments[0], /"retryInMs":3000/)
    client.syncFrom("")
    watches[2].emit("error", new TypeError("Failed to fetch"))
    assert.equal(statuses.at(-1).state, "disabled")
  } finally { client.syncFrom("") }
})

test("a prolonged outage caps backoff at one minute", async t => {
  const warnings = t.mock.method(console, "warn", () => {})
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const remote = compatibilityDatabase()
  remote.get = async () => { throw { status: 503 } }
  const client = new PouchSyncService(compatibilityDatabase(), () => {}, () => remote)
  try {
    client.syncFrom("https://sync.test/once"); await flush()
    for (const delay of [3000, 6000, 12000, 24000, 48000, 60000, 60000]) {
      assert.match(warnings.mock.calls.at(-1).arguments[0], new RegExp(`"retryInMs":${delay}`))
      t.mock.timers.tick(delay); await flush()
    }
  } finally { client.syncFrom("") }
})
