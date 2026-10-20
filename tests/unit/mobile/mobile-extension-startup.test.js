const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const exportsObject = {}
const source = fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/src/mobileExtensionSettings.ts"), "utf8")
Function("exports", "require", ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText)(exportsObject, () => ({ createViolentmonkeyHandOff: () => null }))
const settle = () => new Promise(resolve => setImmediate(resolve))

test("initial readiness includes a settings change received during the first application", async () => {
  const subscriptions = new Map()
  const applications = []
  const client = {
    getFilterLists: async () => ({ version: 1, lists: [] }),
    getUserscripts: async () => ({ version: 1, scripts: [] }),
    subscribe: (name, handler) => subscriptions.set(name, handler)
  }
  let ready = false
  const binding = exportsObject.bindMobileExtensionSettings(client, {
    applyExtensionSettings: () => new Promise(resolve => applications.push(resolve))
  }).then(value => { ready = true; return value })
  await settle()
  assert.equal(applications.length, 1)
  subscriptions.get("settingsChanged")({ section: "extensions" })
  await settle()
  assert.equal(applications.length, 2)
  applications[0]()
  await settle()
  assert.equal(ready, false, "a superseded application cannot release initial navigation")
  applications[1]()
  assert.equal(typeof await binding, "function")
})

test("initial navigation also waits for the userscript hand-off", async () => {
  let release
  let ready = false
  const binding = exportsObject.bindMobileExtensionSettings({
    getFilterLists: async () => ({ lists: [] }),
    getUserscripts: async () => ({ scripts: [] }),
    subscribe() {}
  }, { applyExtensionSettings: async () => {} }, {
    apply: () => new Promise(resolve => { release = resolve }),
    onConnected() {},
    onDashboardChanged() {}
  }).then(() => { ready = true })
  await settle()
  assert.equal(ready, false)
  release()
  await binding
  assert.equal(ready, true)
})

test("a stale surface acknowledgement cannot reinstall older userscripts", async () => {
  const handlers = new Map()
  const surfaceReplies = []
  const versions = []
  const binding = exportsObject.bindMobileExtensionSettings({
    getFilterLists: async () => ({ lists: [] }),
    getUserscripts: async () => ({ version: 1, scripts: [] }),
    subscribe: (name, handler) => handlers.set(name, handler)
  }, {
    applyExtensionSettings: () => new Promise(resolve => surfaceReplies.push(resolve))
  }, {
    apply: async document => { versions.push(document.version) },
    onConnected() {},
    onDashboardChanged() {}
  })
  await settle()
  handlers.get("extensionSettingsChanged")({ filterLists: { lists: [] }, userscripts: { version: 2, scripts: [] } })
  await settle()
  surfaceReplies[1]()
  await settle()
  surfaceReplies[0]()
  await binding
  assert.deepEqual(versions, [2])
})

test("VM connection waits for initial filters but does not apply them again", async () => {
  let connected, releaseFilters
  let filterReads = 0, filterApplies = 0, scripts = 0
  let ready = false
  const binding = exportsObject.bindMobileExtensionSettings({
    getFilterLists: async () => { filterReads++; return { lists: [] } },
    getUserscripts: async () => ({ scripts: [] }), subscribe() {}
  }, { applyExtensionSettings: () => { filterApplies++; return new Promise(resolve => { releaseFilters = resolve }) } }, {
    apply: async () => { scripts++ }, onConnected: handler => { connected = handler }, onDashboardChanged() {}
  }).then(() => { ready = true })
  await settle()
  connected()
  await settle()
  assert.equal(ready, false)
  assert.equal(scripts, 0)
  releaseFilters()
  await binding
  assert.equal(filterReads, 1)
  assert.equal(filterApplies, 1)
  assert.equal(scripts, 2)
  connected()
  await settle()
  assert.equal(filterApplies, 1)
  assert.equal(scripts, 3)
})
