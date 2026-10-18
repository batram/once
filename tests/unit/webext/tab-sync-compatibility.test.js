const test = require("node:test")
const assert = require("node:assert/strict")
const { tabSyncCompatibility } = require("../../../packages/webext-shell/dist/tabSyncCompatibility")

test("every background request stops once the database announces a move", async t => {
  const { SyncEpochPendingError } = require("../../../packages/persistence/dist")
  let epoch = null
  const requested = []
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(String(url))
    if (String(url).includes("once_sync_compat")) {
      return new Response(JSON.stringify({ _id: "once_sync_compat", _rev: "1-fixture", schema: 1, minSyncProtocol: 3 }), { status: 200 })
    }
    if (String(url).includes("once_sync_epoch") && epoch) return new Response(JSON.stringify({ _id: "once_sync_epoch", _rev: "1-x", ...epoch }), { status: 200 })
    return new Response(JSON.stringify({ error: "not_found", reason: "missing" }), { status: 404 })
  })
  const stored = new Map()
  const check = tabSyncCompatibility("https://user:secret@sync.test/once", { get: async id => stored.get(id) ?? "", set: async (id, value) => { stored.set(id, value) } }, async () => true)
  await check()
  assert.ok(requested.some(url => url.includes("once_sync_epoch")), "the marker is read on every check")
  for (const state of ["preparing", "ready"]) {
    epoch = { schema: 1, state, next: "once_e2" }
    await assert.rejects(check(), SyncEpochPendingError, `a write after ${state} would be stranded in the old database`)
  }
})

test("background HTTP publication checks the marker and remembers a higher requirement", async t => {
  const stored = new Map(), calls = []
  let minimum = 5
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, method: init.method ?? "GET" })
    return new Response(JSON.stringify({ _id: "once_sync_compat", _rev: "1-fixture", schema: 1, minSyncProtocol: minimum }), { status: 200 })
  })
  const check = tabSyncCompatibility("https://user:secret@sync.test/once", { get: async id => stored.get(id) ?? "", set: async (id, value) => { stored.set(id, value) } }, async () => true)
  await assert.rejects(check(), error => error.compatibility?.requiredSyncProtocol === 5)
  assert.ok(calls.every(call => !call.url.includes("secret") && call.method === "GET" && call.url.includes("once_sync_compat")))
  minimum = 1
  await assert.rejects(check(), /newer version/)
  assert.ok(stored.size > 0)
})
