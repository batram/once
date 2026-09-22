const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

function load() {
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    "../../../apps/electron/src/browser/reader-url.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  Function("exports", "require", compiled)(module.exports, () => { throw Error("no imports") })
  return module.exports
}

test("a page without a title is named by its minimal URL", () => {
  const { fallbackTabTitle } = load()
  assert.equal(fallbackTabTitle("https://www.example.com/"), "example.com")
  assert.equal(fallbackTabTitle("http://example.com/a/b?x=1#frag"), "example.com/a/b?x=1#frag")
  assert.equal(fallbackTabTitle("https://news.ycombinator.com/item?id=1"), "news.ycombinator.com/item?id=1")
  assert.equal(fallbackTabTitle("https://localhost:3211/"), "localhost:3211")
})

test("reader views are named after their source page", () => {
  const { fallbackTabTitle } = load()
  assert.equal(fallbackTabTitle("once-reader://https/www.example.com/post/"), "example.com/post")
})

test("anything that is not a web page stays New tab", () => {
  const { fallbackTabTitle } = load()
  assert.equal(fallbackTabTitle("about:blank"), "New tab")
  assert.equal(fallbackTabTitle(""), "New tab")
  assert.equal(fallbackTabTitle("chrome-extension://abc/popup.html"), "New tab")
  assert.equal(fallbackTabTitle("not a url"), "New tab")
})
