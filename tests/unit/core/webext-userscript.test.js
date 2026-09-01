const test = require("node:test")
const assert = require("node:assert/strict")
const {
  UserscriptError,
  UserscriptMatcher,
  parseUserscript
} = require("../../../packages/core/dist/webext/userscript")

const SOURCE = `// ==UserScript==
// @name         Example fixer
// @namespace    https://example.org/
// @version      1.2
// @description  Removes the thing
// @match        https://*.example.org/*
// @include      https://alt.test/*
// @exclude      https://www.example.org/admin/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_getValue
// @require      https://cdn.test/lib.js
// @noframes
// @custom       anything goes
// ==/UserScript==
console.log("hi")
`

test("the header block parses into metadata and the body is what follows it", () => {
  const { metadata, body } = parseUserscript(SOURCE)
  assert.equal(metadata.name, "Example fixer")
  assert.equal(metadata.namespace, "https://example.org/")
  assert.equal(metadata.version, "1.2")
  assert.equal(metadata.description, "Removes the thing")
  assert.deepEqual(metadata.matches, ["https://*.example.org/*"])
  assert.deepEqual(metadata.includes, ["https://alt.test/*"])
  assert.deepEqual(metadata.excludes, ["https://www.example.org/admin/*"])
  assert.equal(metadata.runAt, "document-start")
  assert.equal(metadata.noFrames, true)
  assert.deepEqual(metadata.grants, ["GM_addStyle", "GM_getValue"])
  assert.deepEqual(metadata.requires, ["https://cdn.test/lib.js"])
  assert.deepEqual(metadata.raw.get("custom"), ["anything goes"])
  assert.equal(body, 'console.log("hi")\n')
})

test("defaults apply when keys are absent", () => {
  const { metadata } = parseUserscript("// ==UserScript==\n// @name x\n// ==/UserScript==\nx()")
  assert.equal(metadata.runAt, "document-end")
  assert.equal(metadata.noFrames, false)
  assert.deepEqual(metadata.grants, [])
})

test("missing header parts and bad values are rejected", () => {
  assert.throws(() => parseUserscript("x()"), UserscriptError)
  assert.throws(() => parseUserscript("// ==UserScript==\n// @name x\n"), UserscriptError)
  assert.throws(() => parseUserscript("// ==UserScript==\n// ==/UserScript==\n"), /@name/)
  assert.throws(
    () => parseUserscript("// ==UserScript==\n// @name x\n// @run-at later\n// ==/UserScript==\n"),
    /@run-at/
  )
  assert.throws(
    () => parseUserscript("// ==UserScript==\n// @name x\n// @match nope\n// ==/UserScript==\n"),
    UserscriptError
  )
})

test("matching follows Greasemonkey precedence", () => {
  const matcher = new UserscriptMatcher(parseUserscript(SOURCE).metadata)
  const hits = (url) => matcher.matchesUrl(new URL(url))
  assert.equal(hits("https://example.org/page"), true)
  assert.equal(hits("https://www.example.org/page"), true)
  assert.equal(hits("https://www.example.org/admin/users"), false)
  assert.equal(hits("https://alt.test/anything"), true)
  assert.equal(hits("https://other.test/"), false)
})

test("a script with no @match or @include runs everywhere except its excludes", () => {
  const { metadata } = parseUserscript(
    "// ==UserScript==\n// @name x\n// @exclude /^https:\\/\\/skip\\./\n// ==/UserScript==\n"
  )
  const matcher = new UserscriptMatcher(metadata)
  assert.equal(matcher.matchesUrl(new URL("https://anything.test/")), true)
  assert.equal(matcher.matchesUrl(new URL("https://skip.test/")), false)
})

test("@include globs escape regex characters and honour /regex/ literals", () => {
  const { metadata } = parseUserscript(
    "// ==UserScript==\n// @name x\n// @include https://a.test/x.y?*\n// @include /b\\.test\\/\\d+$/\n// ==/UserScript==\n"
  )
  const matcher = new UserscriptMatcher(metadata)
  assert.equal(matcher.matchesUrl(new URL("https://a.test/x.y?q=1")), true)
  assert.equal(matcher.matchesUrl(new URL("https://a.test/xzy?q=1")), false)
  assert.equal(matcher.matchesUrl(new URL("https://b.test/42")), true)
  assert.equal(matcher.matchesUrl(new URL("https://b.test/abc")), false)
})
