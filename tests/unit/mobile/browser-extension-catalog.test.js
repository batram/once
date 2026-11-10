const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  "../../../packages/platform-mobile/src/BrowserExtensions.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

/** The catalog API over a native plugin whose commands the test settles itself. */
function extensionsApi(platform) {
  const exports = {}
  const requests = []
  Function("exports", "require", code)(exports, name => name === "@capacitor/core"
    ? { Capacitor: { getPlatform: () => platform } }
    : { NativeInAppBrowser: { extensionCommand: options => new Promise((resolve, reject) => requests.push({ options, resolve, reject })) } })
  return { api: exports.createMobileBrowserExtensions(), requests }
}

test("concurrent catalog readers share one native query and a failure can be retried", async () => {
  const { api, requests } = extensionsApi("android")
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

test("a refresh list does not join the shared plain query", async () => {
  const { api, requests } = extensionsApi("ios")
  const plain = api.command({ action: "list" })
  const refresh = api.command({ action: "list", refresh: true })
  assert.notEqual(refresh, plain)
  assert.deepEqual(requests.map(request => request.options), [{ action: "list" }, { action: "list", refresh: true }])
  requests[0].resolve({ extensions: [], snapshot: true })
  requests[1].resolve({ extensions: [] })
  assert.deepEqual(await plain, { extensions: [], snapshot: true })
  assert.deepEqual(await refresh, { extensions: [] })
})
