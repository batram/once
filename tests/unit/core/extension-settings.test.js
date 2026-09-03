const test = require("node:test")
const assert = require("node:assert/strict")
const {
  parseFilterListsText,
  parseUserscriptsText,
  presentFilterLists,
  presentUserscripts,
  readFilterListsDocument,
  readUserscriptsDocument,
  userscriptId
} = require("../../../packages/core/dist/settings/extensionSettings")

const SCRIPT_A = `// ==UserScript==
// @name  A
// @namespace once.test
// @match https://a.test/*
// ==/UserScript==
a()`

const SCRIPT_B = `// ==UserScript==
// @name  B
// @match https://b.test/*
// ==/UserScript==
b()`

test("filter list text keeps order, marks disabled lines, and rejects non-URLs", () => {
  const doc = parseFilterListsText("https://easylist.to/easylist/easylist.txt\n\n# https://example.test/off.txt\n")
  assert.deepEqual(doc.lists, [
    { url: "https://easylist.to/easylist/easylist.txt", enabled: true },
    { url: "https://example.test/off.txt", enabled: false }
  ])
  assert.equal(presentFilterLists(doc), "https://easylist.to/easylist/easylist.txt\n# https://example.test/off.txt")
  assert.throws(() => parseFilterListsText("not a url"), /Not a filter list URL: not a url/)
  assert.equal(parseFilterListsText("https://x.test/a\nhttps://x.test/a").lists.length, 1)
})

test("filter list documents from other clients are read tolerantly", () => {
  assert.deepEqual(readFilterListsDocument(null).lists, [])
  assert.deepEqual(readFilterListsDocument({ version: 2, lists: [{ url: "https://x.test/" }] }).lists, [])
  assert.deepEqual(readFilterListsDocument({
    version: 1,
    lists: [{ url: " https://x.test/a " }, { url: "ftp://no" }, 7, { url: "https://x.test/b", enabled: false }]
  }).lists, [
    { url: "https://x.test/a", enabled: true },
    { url: "https://x.test/b", enabled: false }
  ])
})

test("userscript text splits on headers, keeps sources, and derives stable ids", () => {
  const doc = parseUserscriptsText(`${SCRIPT_A}\n\n${SCRIPT_B}\n`)
  assert.deepEqual(doc.scripts.map((s) => [s.id, s.name, s.enabled]), [
    [userscriptId("once.test", "A"), "A", true],
    [userscriptId(null, "B"), "B", true]
  ])
  assert.equal(doc.scripts[0].source, SCRIPT_A)
  assert.equal(doc.scripts[1].source, SCRIPT_B)
  assert.equal(presentUserscripts(doc), `${SCRIPT_A}\n\n${SCRIPT_B}`)
  assert.notEqual(userscriptId("once.test", "A"), userscriptId("other", "A"))
})

test("a disabled userscript round-trips through the marker line", () => {
  const doc = parseUserscriptsText(SCRIPT_A)
  doc.scripts[0].enabled = false
  const text = presentUserscripts(doc)
  assert.match(text, /\/\/ ==UserScript==\n\/\/ @once-disabled\n/)
  const again = parseUserscriptsText(text)
  assert.equal(again.scripts[0].enabled, false)
  again.scripts[0].enabled = true
  assert.equal(presentUserscripts(again), text)
})

test("userscript text errors name the script and reject stray text and duplicates", () => {
  assert.throws(() => parseUserscriptsText("console.log(1)"), /must start with/)
  assert.throws(() => parseUserscriptsText("// ==UserScript==\n// ==/UserScript==\n"), /Userscript 1: .*@name/)
  assert.throws(() => parseUserscriptsText(`${SCRIPT_A}\n${SCRIPT_A}`), /appears twice/)
  assert.deepEqual(parseUserscriptsText("  \n").scripts, [])
})

test("userscript documents from other clients drop what cannot be parsed", () => {
  const doc = readUserscriptsDocument({
    version: 1,
    scripts: [{ source: SCRIPT_A, enabled: false }, { source: "garbage" }, { source: SCRIPT_A }]
  })
  assert.deepEqual(doc.scripts.map((s) => [s.name, s.enabled]), [["A", false]])
})
