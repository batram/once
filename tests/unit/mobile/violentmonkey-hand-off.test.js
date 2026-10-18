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
    async send({ cmd }) { calls.push(cmd); return { value: { OnceReadRecords: {}, ExportZip: { items: [] } }[cmd] ?? null } },
    async handingOff() { calls.push("handingOff") },
    async settled() { calls.push("settled") },
    async addListener() { return { remove: async () => undefined } }
  }
  await loadHandOff(stub).apply(emptyUserscriptsDocument())
  assert.deepEqual(calls, ["OnceReadRecords", "handingOff", "ExportZip", "OnceWriteRecords", "settled"])
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
  assert.deepEqual(calls, ["OnceReadRecords"])
})
