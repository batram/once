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
    "https://",
    "lwn.net",
    "/Articles",
    "/990001/",
    "?page=2",
    "&utm_source=rss",
    "&utm_medium=feed",
    "#comments"
  ].join("\n"))
  assert.equal(parts.explodeAddress("https://example.com/"), "https://\nexample.com/")
  assert.equal(parts.explodeAddress("lwn.net/x"), "lwn.net\n/x")
  assert.equal(parts.explodeAddress("/articles/42/?q=1"), "/articles\n/42/\n?q=1")
})

test("joining an exploded address gives the same address back", () => {
  for (const address of [ARTICLE, "https://example.com/", "https://a.b/c", "lwn.net/x?y=1", "/a/?b", "https:///a", "/", "not a url", ""]) {
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

test("a swiped-away line leaves a valid address", () => {
  const display = parts.explodeAddress(ARTICLE)
  const without = (exploded, index) => parts.joinAddress(parts.removeExplodedLine(exploded, index))
  assert.equal(without(display, 0), "lwn.net/Articles/990001/?page=2&utm_source=rss&utm_medium=feed#comments")
  assert.equal(without(display, 2), "https://lwn.net/990001/?page=2&utm_source=rss&utm_medium=feed#comments")
  assert.equal(without(display, 4), "https://lwn.net/Articles/990001/?utm_source=rss&utm_medium=feed#comments")
  assert.equal(without(display, 5), "https://lwn.net/Articles/990001/?page=2&utm_medium=feed#comments")
  assert.equal(without(display, 7), "https://lwn.net/Articles/990001/?page=2&utm_source=rss&utm_medium=feed")
  const single = parts.explodeAddress("https://x.test/a?only=1")
  assert.equal(without(single, 3), "https://x.test/a")
})

test("a long part explodes further at word and label separators", () => {
  assert.equal(parts.explodeLine("/the-hetzner-cloud-network"), "/the\n-hetzner\n-cloud\n-network")
  assert.equal(parts.explodeLine("www.hetzner.com"), "www\n.hetzner\n.com")
  assert.equal(parts.explodeLine("&utm_source=rss"), "&utm\n_source\n=rss")
  assert.equal(parts.explodeLine("/a--b"), "/a\n-\n-b")
  assert.equal(parts.explodeLine("https://"), "https://")
  assert.equal(parts.explodeLine("/plain"), "/plain")
  assert.equal(parts.explodeLine("-lead"), "-lead")
  const display = parts.explodeAddress("https://www.hetzner.com/blog/the-cloud/")
  const finer = parts.explodeLines(display, 3, 4)
  assert.equal(finer, "https://\nwww.hetzner.com\n/blog\n/the\n-cloud/")
  assert.equal(parts.joinAddress(finer), "https://www.hetzner.com/blog/the-cloud/")
  assert.equal(parts.removeExplodedLine(finer, 4), "https://\nwww.hetzner.com\n/blog\n/the")
  assert.equal(parts.lineIndexAt(finer, 0), 0)
  assert.equal(parts.lineIndexAt(finer, finer.indexOf("/the")), 3)
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
