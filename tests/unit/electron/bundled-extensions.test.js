const assert = require("node:assert/strict")
const fs = require("node:fs")
const Module = require("node:module")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const originalTs = Module._extensions[".ts"]
Module._extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8")
  const output = ts.transpileModule(source, {
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
const {
  BUNDLED_EXTENSIONS,
  bundledExtensionRoot,
  resolveBundledExtensions
} = require(path.join(root, "apps/electron/src/extensions/bundledExtensions.ts"))

test("the vendor root is resources/extensions when packaged and vendor/extensions in a checkout", () => {
  assert.equal(
    bundledExtensionRoot({ isPackaged: true, resourcesPath: "/app/resources", appPath: "/app/resources/app.asar" }),
    path.join("/app/resources", "extensions")
  )
  const vendor = path.join(root, "vendor", "extensions")
  const checkout = { isPackaged: false, resourcesPath: "/unused" }
  const onlyVendor = (directory) => directory === vendor
  assert.equal(
    bundledExtensionRoot({ ...checkout, appPath: path.join(root, "apps", "electron") }, onlyVendor),
    vendor
  )
  // The e2e harness runs the webpack output directly, so the app path is
  // deeper; the walk still finds the checkout's vendor directory.
  assert.equal(
    bundledExtensionRoot(
      { ...checkout, appPath: path.join(root, "apps", "electron", ".webpack", "x64", "main") },
      onlyVendor
    ),
    vendor
  )
  // Nothing fetched yet: the conventional spot, so the warning names it.
  assert.equal(
    bundledExtensionRoot({ ...checkout, appPath: path.join(root, "apps", "electron") }, () => false),
    vendor
  )
})

test("every listed extension resolves to its directory and reports whether it is fetched", () => {
  const present = new Set([path.join("/v", "ublock-origin", "manifest.json")])
  const sources = resolveBundledExtensions("/v", (file) => present.has(file))
  assert.equal(sources.length, BUNDLED_EXTENSIONS.length)
  assert.deepEqual(sources.map((s) => [s.id, path.basename(s.directory), s.present]), [
    ["uBlock0@raymondhill.net", "ublock-origin", true],
    ["{aecec67f-0d10-4fa7-b7c7-609a2db280cf}", "violentmonkey", false]
  ])
})

test("the list and the fetch script agree on ids and directories", () => {
  const script = fs.readFileSync(path.join(root, "scripts", "fetch-extensions.js"), "utf8")
  for (const entry of BUNDLED_EXTENSIONS) {
    assert.ok(script.includes(`name: "${entry.directory}"`), entry.directory)
    assert.ok(script.includes(`id: "${entry.id}"`), entry.id)
  }
})
