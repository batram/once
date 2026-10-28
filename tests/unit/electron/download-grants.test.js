const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

function load() {
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    "../../../apps/electron/src/browser/DownloadGrants.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  Function("exports", "require", compiled)(module.exports, () => { throw Error("no imports") })
  return module.exports
}

test("a granted download is taken once, by its own URL, within its window", () => {
  const { DownloadGrants } = load()
  let time = 0
  const grants = new DownloadGrants(() => time)
  const url = "https://addons.mozilla.org/firefox/downloads/file/1/one.xpi"
  assert.equal(grants.take(url), false)
  grants.grant(url)
  assert.equal(grants.take("https://addons.mozilla.org/firefox/downloads/file/2/two.xpi"), false)
  assert.equal(grants.take(url), true)
  assert.equal(grants.take(url), false)
  grants.grant(url)
  time += 5000
  assert.equal(grants.take(url), false)
})
