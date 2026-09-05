const assert = require("node:assert/strict")
const fs = require("node:fs")
const Module = require("node:module")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const electronStub = {
  app: { getLocale: () => "en-US" },
  protocol: { registerSchemesAsPrivileged() {} },
  session: { fromPartition: () => ({}) }
}
const originalLoad = Module._load
const originalTs = Module._extensions[".ts"]
Module._load = function load(request, parent, isMain) {
  if (request === "electron") return electronStub
  return originalLoad.call(this, request, parent, isMain)
}
Module._extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8")
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename
  }).outputText
  module._compile(output, filename)
}
test.after(() => {
  Module._load = originalLoad
  if (originalTs) Module._extensions[".ts"] = originalTs
  else delete Module._extensions[".ts"]
})

const root = path.resolve(__dirname, "../../..")
const { ublockSelection, reconcileUblockLists } = require(path.join(root, "apps/electron/src/extensions/extensionSettingsApply.ts"))
const { ExtensionSettingsCoordinator } = require(path.join(root, "apps/electron/src/extensions/ExtensionSettingsCoordinator.ts"))

test("settings queues are independent per extension and suppress stale adoption", async () => {
  const hosts = ["one", "two"].map(id => ({ extension: { id, host: id, name: id } }))
  const calls = [], adopted = []
  const coordinator = new ExtensionSettingsCoordinator("unused", () => hosts, () => {}, (host, settings) =>
    new Promise(resolve => calls.push({ host: host.extension.id, version: settings.userscripts.version, resolve })))
  coordinator.onAdopted(value => adopted.push(value))
  const settings = version => ({ filterLists: { lists: [] }, userscripts: { version, scripts: [] } })
  const first = coordinator.applySettings(settings(1))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.map(call => call.host), ["one", "two"])
  const latest = coordinator.applySettings(settings(2))
  calls[0].resolve({ userscripts: { version: 99, scripts: [] } })
  calls[1].resolve({})
  await first
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(adopted, [])
  assert.deepEqual(calls.map(call => call.version), [1, 1, 2, 2])
  calls[2].resolve({})
  calls[3].resolve({})
  await latest
  assert.equal(coordinator.status(hosts[0]).state, "applied")
})

const table = {
  available: {
    "easylist": { contentURL: ["assets/thirdparties/easylist.txt", "https://easylist.to/easylist/easylist.txt"], off: false },
    "DEU-0": { contentURL: "https://easylist-downloads.adblockplus.org/easylistgermany.txt", off: true },
    "ublock-filters": { contentURL: "assets/ublock/filters.txt", off: false },
    "https://imported.test/list.txt": { contentURL: "https://imported.test/list.txt", off: false }
  }
}

test("Once's subscriptions add to uBlock's selection and never replace it", () => {
  const result = ublockSelection(table, [
    { url: "https://easylist-downloads.adblockplus.org/easylistgermany.txt", enabled: true },
    { url: "https://new.test/list.txt", enabled: true }
  ])
  assert.deepEqual(result.toSelect.sort(), ["DEU-0", "easylist", "https://imported.test/list.txt", "ublock-filters"])
  assert.equal(result.toImport, "https://new.test/list.txt")
  assert.deepEqual(result.toRemove, [])
})

test("removed subscriptions restore the selection that predated Once ownership", () => {
  const before = reconcileUblockLists(table, [
    { url: "https://easylist.to/easylist/easylist.txt", enabled: false },
    { url: "https://new.test/list.txt", enabled: true }
  ], {})
  assert.deepEqual(before.baseline, {
    "https://easylist.to/easylist/easylist.txt": true,
    "https://new.test/list.txt": false
  })
  const afterTable = { available: { ...table.available,
    easylist: { ...table.available.easylist, off: true },
    "https://new.test/list.txt": { off: false }
  } }
  const after = reconcileUblockLists(afterTable, [], before.baseline)
  const selection = ublockSelection(afterTable, after.lists)
  assert.equal(selection.toSelect.includes("easylist"), true)
  assert.equal(selection.toSelect.includes("https://imported.test/list.txt"), true)
  assert.deepEqual(selection.toRemove, ["https://new.test/list.txt"])
  assert.deepEqual(after.baseline, {})
})

test("a disabled list is deselected by its stock key or removed when it was imported", () => {
  const result = ublockSelection(table, [
    { url: "http://easylist.to/easylist/easylist.txt", enabled: false },
    { url: "https://imported.test/list.txt", enabled: false },
    { url: "https://unknown.test/list.txt", enabled: false }
  ])
  assert.deepEqual(result.toSelect, ["ublock-filters"])
  assert.equal(result.toImport, "")
  assert.deepEqual(result.toRemove, ["https://imported.test/list.txt"])
})
