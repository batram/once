const test = require("node:test")
const assert = require("node:assert/strict")
const {
  parseFilterListsText,
  parseUserscriptsText,
  presentFilterLists,
  presentUserscripts,
  readFilterListsDocument,
  readUserscriptsDocument,
  removeUserscript,
  setUserscriptEnabled,
  summarizeUserscript,
  upsertUserscript,
  USERSCRIPT_TEMPLATE,
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

test("one script is added, replaced in place and renamed without touching the rest", () => {
  const doc = parseUserscriptsText(`${SCRIPT_A}\n\n${SCRIPT_B}`)
  const idA = userscriptId("once.test", "A")
  const edited = upsertUserscript(doc, SCRIPT_A.replace("a()", "a2()"), { replacing: idA })
  assert.deepEqual(edited.next.scripts.map((script) => script.name), ["A", "B"])
  assert.match(edited.next.scripts[0].source, /a2\(\)/)
  assert.equal(edited.next.scripts[1], doc.scripts[1])

  const renamed = upsertUserscript(doc, SCRIPT_A.replace("@name  A", "@name  A2"), { replacing: idA })
  assert.deepEqual(renamed.next.scripts.map((script) => script.name), ["A2", "B"])
  assert.equal(renamed.entry.id, userscriptId("once.test", "A2"))

  const added = upsertUserscript(doc, USERSCRIPT_TEMPLATE)
  assert.deepEqual(added.next.scripts.map((script) => script.name), ["A", "B", "New script"])
  assert.equal(added.entry.enabled, true)
})

test("a script cannot take another's name, and a broken header is an error", () => {
  const doc = parseUserscriptsText(`${SCRIPT_A}\n\n${SCRIPT_B}`)
  assert.throws(() => upsertUserscript(doc, SCRIPT_B.replace("b()", "c()")), /already called "B"/)
  assert.throws(() => upsertUserscript(doc, "alert(1)"), /==UserScript==/)
})

test("switching a script keeps its source and drops the text form's marker on the way on", () => {
  const doc = parseUserscriptsText(SCRIPT_A.replace("// @name", "// @once-disabled\n// @name"))
  const id = doc.scripts[0].id
  assert.equal(doc.scripts[0].enabled, false)
  const on = setUserscriptEnabled(doc, id, true)
  assert.equal(on.scripts[0].enabled, true)
  assert.doesNotMatch(on.scripts[0].source, /once-disabled/)
  assert.equal(parseUserscriptsText(presentUserscripts(on)).scripts[0].enabled, true)
  const off = setUserscriptEnabled(on, id, false)
  assert.equal(parseUserscriptsText(presentUserscripts(off)).scripts[0].enabled, false)
  assert.deepEqual(removeUserscript(off, id).scripts, [])
})

test("the summary reads where a script runs and only offers safe icons", () => {
  const summary = summarizeUserscript(`// ==UserScript==
// @name  Icons
// @version 2.1
// @icon  javascript:alert(1)
// @iconURL https://example.test/icon.png
// @match https://a.test/*
// @include https://b.test/*
// @exclude https://a.test/private/*
// @grant GM_xmlhttpRequest
// @grant none
// @noframes
// ==/UserScript==`)
  assert.equal(summary.version, "2.1")
  assert.equal(summary.icon, "https://example.test/icon.png")
  assert.deepEqual(summary.sites, ["https://a.test/*", "https://b.test/*"])
  assert.deepEqual(summary.excludes, ["https://a.test/private/*"])
  assert.deepEqual(summary.grants, ["GM_xmlhttpRequest"])
  assert.equal(summary.noFrames, true)
  assert.equal(summarizeUserscript("not a script"), null)
})
