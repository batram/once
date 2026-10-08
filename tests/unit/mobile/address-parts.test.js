const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const root = path.resolve(__dirname, "../../..")

function load() {
  const source = fs.readFileSync(path.join(root, "apps/mobile/src/addressParts.ts"), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const moduleObject = { exports: {} }
  Function("exports", "module", compiled)(moduleObject.exports, moduleObject)
  return moduleObject.exports
}

const parts = load()
const ARTICLE = "https://lwn.net/Articles/990001/?page=2&utm_source=rss&utm_medium=feed#comments"

test("an exploded address puts each part on its own line", () => {
  assert.equal(parts.explodeAddress(ARTICLE), [
    "https://lwn.net",
    "/Articles",
    "/990001/",
    "?page=2",
    "&utm_source=rss",
    "&utm_medium=feed",
    "#comments"
  ].join("\n"))
  assert.equal(parts.explodeAddress("https://example.com/"), "https://example.com/")
})

test("joining an exploded address gives the same address back", () => {
  for (const address of [ARTICLE, "https://example.com/", "https://a.b/c", "lwn.net/x?y=1", "not a url", ""]) {
    assert.equal(parts.joinAddress(parts.explodeAddress(address)), address)
  }
})

test("caret offsets survive exploding and joining", () => {
  const display = parts.explodeAddress(ARTICLE)
  for (let offset = 0; offset <= ARTICLE.length; offset += 1) {
    const shown = parts.displayOffset(display, offset)
    assert.equal(parts.joinedOffset(display, shown), offset)
    assert.equal(display.slice(0, shown).replace(/\n/g, ""), ARTICLE.slice(0, offset))
  }
})

test("Remove takes the query first, then one path segment at a time", () => {
  let step = parts.lastAddressPart(ARTICLE)
  assert.equal(step.label, "?page=2&utm_source=rss&utm_medium=feed#comments")
  assert.equal(step.rest, "https://lwn.net/Articles/990001/")
  step = parts.lastAddressPart(step.rest)
  assert.deepEqual(step, { label: "/990001", rest: "https://lwn.net/Articles/" })
  step = parts.lastAddressPart(step.rest)
  assert.deepEqual(step, { label: "/Articles", rest: "https://lwn.net/" })
  assert.equal(parts.lastAddressPart(step.rest), null)
  assert.equal(parts.lastAddressPart("lwn.net/x"), null)
})

test("tracking parameters are found and removed, other parameters stay", () => {
  assert.deepEqual(parts.trackingParameters(ARTICLE), ["utm_source", "utm_medium"])
  assert.equal(parts.withoutTrackingParameters(ARTICLE), "https://lwn.net/Articles/990001/?page=2#comments")
  assert.equal(parts.withoutTrackingParameters("https://x.test/?fbclid=1"), "https://x.test/")
  assert.deepEqual(parts.trackingParameters("https://x.test/?q=si"), [])
})
