const test = require("node:test")
const assert = require("node:assert/strict")
const { tabSyncCompatibility } = require("../../../packages/webext-shell/dist/tabSyncCompatibility")

test("background HTTP publication checks the marker and remembers a higher requirement", async t => {
  const stored = new Map(), calls = []
  let minimum = 4
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, method: init.method ?? "GET" })
    return new Response(JSON.stringify({ _id: "once_sync_compat", _rev: "1-fixture", schema: 1, minSyncProtocol: minimum }), { status: 200 })
  })
  const check = tabSyncCompatibility("https://user:secret@sync.test/once", { get: async id => stored.get(id) ?? "", set: async (id, value) => { stored.set(id, value) } }, async () => true)
  await assert.rejects(check(), error => error.compatibility?.requiredSyncProtocol === 4)
  assert.ok(calls.every(call => !call.url.includes("secret") && call.method === "GET" && call.url.includes("once_sync_compat")))
  minimum = 1
  await assert.rejects(check(), /newer version/)
  assert.ok(stored.size > 0)
})
