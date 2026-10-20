const test = require("node:test")
const assert = require("node:assert/strict")
const Module = require("node:module")

const { emptyUserscriptsDocument } = require("@once/core")

// The hand-off talks to the native GeckoViolentmonkey plugin through
// Capacitor, which it registers on each call; the stub hands out the plugin
// a test sets, which records the order of its calls.
let plugin
const resolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  return request === "@capacitor/core" ? "@capacitor/core" : resolve.call(this, request, ...rest)
}
require.cache["@capacitor/core"] = {
  id: "@capacitor/core", filename: "@capacitor/core", loaded: true,
  exports: { Capacitor: { getPlatform: () => "android" }, registerPlugin: () => plugin }
}
const { createViolentmonkeyHandOff } = require("../../../packages/platform-mobile/dist/ViolentmonkeyHandOff")
Module._resolveFilename = resolve

function loadHandOff(stub) {
  plugin = stub
  return createViolentmonkeyHandOff()
}

test("pages opening while a later hand-off writes scripts wait for it to settle", async () => {
  const calls = []
  const stub = {
    async send({ cmd }) { calls.push(cmd); return { value: { OnceReadSnapshot: { records: {}, scripts: { items: [] } } }[cmd] ?? null } },
    async handingOff() { calls.push("handingOff") },
    async settled() { calls.push("settled") },
    async addListener() { return { remove: async () => undefined } }
  }
  await loadHandOff(stub).apply(emptyUserscriptsDocument())
  assert.deepEqual(calls, ["OnceReadSnapshot", "handingOff", "settled"])
})

test("a hand-off to a Violentmonkey that is not running holds no pages", async () => {
  const calls = []
  const stub = {
    async send({ cmd }) { calls.push(cmd); throw Object.assign(new Error("Violentmonkey is not running"), { code: "NOT_RUNNING" }) },
    async handingOff() { calls.push("handingOff") },
    async settled() { calls.push("settled") },
    async addListener() { return { remove: async () => undefined } }
  }
  assert.equal(await loadHandOff(stub).apply(emptyUserscriptsDocument()), undefined)
  assert.deepEqual(calls, ["OnceReadSnapshot"])
})

test("unchanged scripts avoid a records write but dashboard edits are still adopted", async () => {
  const crypto = require("node:crypto")
  const { userscriptId } = require("@once/core")
  const code = "// ==UserScript==\n// @name Test\n// @namespace test\n// ==/UserScript==\nold()"
  const hash = s => crypto.createHash("sha256").update(s).digest("hex")
  const id = userscriptId("test", "Test")
  const document = { version: 1, scripts: [{ id, name: "Test", source: code, enabled: true }] }
  let stored = code
  const calls = []
  const handoff = loadHandOff({
    async send({ cmd }) {
      calls.push(cmd)
      if (cmd === "OnceReadSnapshot") return { value: {
        records: { [id]: { id: 1, source: hash(code), code: hash(code), enabled: true } },
        scripts: { items: [{ script: { props: { id: 1 }, meta: { name: "Test", namespace: "test" }, config: { enabled: 1 } }, code: stored }] }
      } }
      return { value: null }
    },
    async handingOff() {}, async settled() {}, async addListener() {}
  })
  assert.equal(await handoff.apply(document), undefined)
  assert.deepEqual(calls, ["OnceReadSnapshot"])
  stored = code.replace("old()", "new()")
  assert.equal((await handoff.apply(document)).scripts[0].source, stored)
  assert.equal(calls.includes("OnceWriteRecords"), true)
  assert.equal(calls.includes("ExportZip"), false)
})

test("an older relay uses its existing read commands without losing the navigation barrier", async () => {
  const calls = []
  const handoff = loadHandOff({
    async send({ cmd }) {
      calls.push(cmd)
      if (cmd === "OnceReadSnapshot") throw new Error("Not a command Once hands to Violentmonkey: OnceReadSnapshot")
      return { value: cmd === "ExportZip" ? { items: [] } : {} }
    }, async handingOff() { calls.push("held") }, async settled() { calls.push("settled") }, async addListener() {}
  })
  await handoff.apply(emptyUserscriptsDocument())
  assert.deepEqual(calls, ["OnceReadSnapshot", "OnceReadRecords", "ExportZip", "held", "settled"])
})

test("a verified unchanged token avoids planning but a changed document forces a fresh snapshot", async () => {
  const requests = []
  let settlements = 0
  const handoff = loadHandOff({
    async send({ cmd, data }) {
      requests.push({ cmd, data })
      return { value: data?.token === "generation:1"
        ? { unchanged: true, token: "generation:1" }
        : { records: {}, scripts: { items: [] }, token: "generation:1" } }
    }, async handingOff() {}, async settled() { settlements++ }, async addListener() {}
  })
  await handoff.apply(emptyUserscriptsDocument())
  await handoff.apply(emptyUserscriptsDocument())
  assert.equal(requests[1].data.token, "generation:1")
  assert.equal(settlements, 2)
  await handoff.apply({ ...emptyUserscriptsDocument(), version: 2 })
  assert.equal(requests[2].data.token, undefined)
})
