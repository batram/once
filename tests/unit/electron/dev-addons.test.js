const assert = require("node:assert/strict")
const fs = require("node:fs")
const Module = require("node:module")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const originalTs = Module._extensions[".ts"]
Module._extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename
  }).outputText
  module._compile(output, filename)
}
test.after(() => {
  if (originalTs) Module._extensions[".ts"] = originalTs
  else delete Module._extensions[".ts"]
})

const root = path.resolve(__dirname, "../../..")
const { devAddonDirectories, devAddonFile, readDevAddons } = require(path.join(root, "apps/electron/src/devAddons.ts"))
const { LocalAddonDirectories } = require(path.join(root, "apps/electron/src/LocalAddonDirectories.ts"))
const { ADDON_SCRIPT, ADDON_INTEGRITY } = require("../../e2e/shared/addon-fixture")

function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "once-dev-addon-"))
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content)
  return dir
}

test("ONCE_ADDONS is PATH-style and resolves to absolute directories", () => {
  assert.deepEqual(devAddonDirectories(undefined), [])
  const two = devAddonDirectories(["a", " b "].join(path.delimiter))
  assert.deepEqual(two, [path.resolve("a"), path.resolve("b")])
})

test("a directory yields its manifest with the script pinned by hash and a served URL", () => {
  const dir = makeDir({
    "once-addon.json": JSON.stringify({ protocol: 1, id: "dev-one", name: "Dev", version: "0.1", script: "main.js", contributions: [] }),
    "main.js": ADDON_SCRIPT
  })
  const [entry] = readDevAddons([dir])
  assert.equal(entry.error, undefined)
  assert.equal(entry.code, ADDON_SCRIPT)
  assert.deepEqual(entry.manifest.script, { url: "once-addon://dev/0/main.js", integrity: ADDON_INTEGRITY })
  assert.equal(devAddonFile([dir], "once-addon://dev/0/main.js"), path.join(dir, "main.js"))
  assert.equal(devAddonFile([dir], "once-addon://dev/0/once-addon.json"), path.join(dir, "once-addon.json"))
  assert.equal(devAddonFile([dir], "once-addon://dev/0/..%2Fetc"), null)
  assert.equal(devAddonFile([dir], "once-addon://dev/1/main.js"), null)
  assert.equal(devAddonFile([dir], "once-addon://sandbox/index.html"), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("a manifest without a script, a bad script name, and a missing manifest each report plainly", () => {
  const plain = makeDir({ "once-addon.json": JSON.stringify({ protocol: 1, id: "plain", name: "P", version: "1", contributions: [] }) })
  const badName = makeDir({ "once-addon.json": JSON.stringify({ script: { file: "../x.js" } }) })
  const empty = makeDir({})
  const [a, b, c] = readDevAddons([plain, badName, empty])
  assert.equal(a.code, null)
  assert.equal(a.error, undefined)
  assert.match(b.error, /plain \.js name/)
  assert.match(c.error, /no once-addon\.json/)
  for (const dir of [plain, badName, empty]) fs.rmSync(dir, { recursive: true, force: true })
})

test("picker directories persist locally, reload changes and unload without removing files", async () => {
  const directory = makeDir({ "once-addon.json": JSON.stringify({ protocol: 1, id: "picked-addon", name: "Picked", version: "1", script: "main.js", contributions: [] }), "main.js": ADDON_SCRIPT })
  const config = makeDir({})
  const file = path.join(config, "directories.json")
  let changes = 0
  let local = new LocalAddonDirectories(file, [], () => { changes++ })
  try {
    local.add(directory)
    assert.equal(local.list()[0].removable, true)
    assert.equal(changes, 1)
    local.dispose()
    local = new LocalAddonDirectories(file, [], () => { changes++ })
    assert.equal(local.list()[0].directory, directory)
    const changed = new Promise(resolve => {
      const timer = setInterval(() => { if (changes > 1) { clearInterval(timer); resolve() } }, 20)
      setTimeout(() => { clearInterval(timer); resolve() }, 3000).unref()
    })
    fs.writeFileSync(path.join(directory, "main.js"), ADDON_SCRIPT + "\n// edited")
    await changed
    assert.ok(changes > 1)
    assert.match(local.list()[0].code, /edited/)
    local.remove(directory)
    assert.equal(local.list().length, 0)
    assert.ok(fs.existsSync(path.join(directory, "main.js")))
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [])
  } finally {
    local.dispose()
    fs.rmSync(directory, { recursive: true, force: true })
    fs.rmSync(config, { recursive: true, force: true })
  }
})
