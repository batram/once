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

const token = "0123456789abcdef0123456789abcdef"

test("the served form names its source after the token host", () => {
  const { sourceUrlFromReaderUrl, readerTokenFromUrl, displayBrowserUrl } = load()
  const served = `once-reader://${token}/https://www.example.com/post/?page=2#top`
  assert.equal(sourceUrlFromReaderUrl(served), "https://www.example.com/post/?page=2#top")
  assert.equal(readerTokenFromUrl(served), token)
  assert.equal(displayBrowserUrl(served), "once-reader://https://www.example.com/post/?page=2#top")
})

test("the readable form still names its source, with or without the colon Chromium drops", () => {
  const { sourceUrlFromReaderUrl, readerTokenFromUrl } = load()
  for (const readable of [
    "once-reader://https://www.example.com/post/",
    "once-reader://https//www.example.com/post/",
    "once-reader://https/www.example.com/post/"
  ]) {
    assert.equal(sourceUrlFromReaderUrl(readable), "https://www.example.com/post/")
    assert.equal(readerTokenFromUrl(readable), null)
  }
})

test("anything else is not a reader URL", () => {
  const { sourceUrlFromReaderUrl, readerTokenFromUrl } = load()
  for (const other of [
    "once-reader://runtime/reader.js",
    "once-reader://nottoken/https://example.com/",
    `once-reader://${token}/file:///etc/passwd`,
    `once-reader://${token}/`,
    "https://example.com/once-reader://x",
    "once-reader://"
  ]) {
    assert.equal(sourceUrlFromReaderUrl(other), null, other)
  }
  assert.equal(readerTokenFromUrl("once-reader://runtime/reader.js"), null)
})
