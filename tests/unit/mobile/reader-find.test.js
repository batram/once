const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const root = path.resolve(__dirname, "../../..")

// The protocol module has no imports, so it transpiles and loads on its own,
// the way the other mobile source-level tests do it.
function loadProtocol() {
  const source = fs.readFileSync(
    path.join(root, "apps/mobile/src/readerFindProtocol.ts"),
    "utf8"
  )
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const moduleObject = { exports: {} }
  Function("exports", "module", "require", compiled)(moduleObject.exports, moduleObject, () => ({}))
  return moduleObject.exports
}

test("locateMatches finds every case-insensitive, non-overlapping occurrence", () => {
  const { locateMatches } = loadProtocol()
  assert.deepEqual(locateMatches("Once upon a time, once more", "once"), [0, 18])
  assert.deepEqual(locateMatches("aaaa", "aa"), [0, 2], "matches do not overlap")
  assert.deepEqual(locateMatches("nothing here", "xyz"), [])
  assert.deepEqual(locateMatches("anything", ""), [], "an empty query matches nothing")
})

test("find requests and responses are recognised only in full", () => {
  const {
    isReaderFindRequest,
    isReaderFindResponse,
    readerFindRequest,
    readerFindResponse
  } = loadProtocol()
  const find = readerFindRequest({ type: "find", query: "reader", forward: true })
  assert.equal(isReaderFindRequest(find), true)
  assert.equal(isReaderFindRequest(readerFindRequest({ type: "clear" })), true)
  assert.equal(isReaderFindRequest({ ...find, forward: "yes" }), false)
  assert.equal(isReaderFindRequest({ ...find, channel: "other" }), false)
  assert.equal(isReaderFindRequest(null), false)

  const result = readerFindResponse({ query: "reader", current: 1, total: 8 })
  assert.equal(isReaderFindResponse(result), true)
  assert.equal(isReaderFindResponse({ ...result, current: 1.5 }), false)
  assert.equal(isReaderFindResponse(find), false, "a request is not a response")
})
