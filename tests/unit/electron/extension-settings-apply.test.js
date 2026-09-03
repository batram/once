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
const { ublockSelection } = require(path.join(root, "apps/electron/src/extensions/extensionSettingsApply.ts"))

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
