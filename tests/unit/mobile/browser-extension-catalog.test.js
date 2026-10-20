const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const ts = require("typescript")

test("concurrent catalog readers share one native query and a failure can be retried", async () => {
  const exports = {}
  const requests = []
  const code = ts.transpileModule(fs.readFileSync("packages/platform-mobile/src/BrowserExtensions.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  Function("exports", "require", code)(exports, name => name === "@capacitor/core"
    ? { Capacitor: { getPlatform: () => "android" } }
    : { NativeInAppBrowser: { extensionCommand: options => new Promise((resolve, reject) => requests.push({ options, resolve, reject })) } })
  const api = exports.createMobileBrowserExtensions()
  const first = api.command({ action: "list" })
  assert.equal(api.command({ action: "list" }), first)
  assert.equal(requests.length, 1)
  requests[0].reject(new Error("busy"))
  await assert.rejects(first, /busy/)
  const second = api.command({ action: "list" })
  assert.equal(requests.length, 2)
  requests[1].resolve({ extensions: [] })
  assert.deepEqual(await second, { extensions: [] })
  const mutation = api.command({ action: "enable", id: "test", enabled: false })
  assert.equal(requests.length, 3)
  requests[2].resolve({})
  await mutation
})
