const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { parseDocument } = require("../../helpers/dom")
const { assertStories } = require("../../helpers/collector-contract")

test("parses configured JSON selectors, processors, tags, and URLs", () => {
  const collector = require("../../../packages/collectors/dist/collectors/jsonSelect")
  const input = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../fixtures/collectors/generic.json"), "utf8"))
  const config = { stories: { sel: "items", all: true }, link: { sel: "href" }, title: { sel: "title", processors: ["trim"] }, timestamp: { sel: "published" }, tags: [{ elements: { class: { sel: "kind" }, text: { sel: "author" } } }] }
  const stories = collector.parse(input, { url: "https://example.com/feed.json", config })
  assertStories(stories, "JX")
  assert.equal(stories[0].title, "JSON title")
  assert.equal(stories[0].tags[0].text, "alice")
  // No configuration is not an error: an unconfigured source has no stories.
  assert.deepEqual(collector.parse(input, { url: "https://example.com/feed.json" }), [])
})

test("parses configured HTML selectors and skips invalid configuration", () => {
  const collector = require("../../../packages/collectors/dist/collectors/genyMatch")
  const doc = parseDocument(fs.readFileSync(path.resolve(__dirname, "../../fixtures/collectors/generic.html"), "utf8"))
  const config = { stories: { sel: "article", all: true }, link: { sel: ".link", component: "href" }, title: { sel: ".link", component: "innerText", processors: ["trim"] }, tags: [{ elements: { text: { sel: ".tag", component: "innerText" } } }] }
  const stories = collector.parse(doc, { url: "https://example.com/", config })
  assertStories(stories, "GY")
  assert.equal(stories[0].title, "Generic title")
  assert.equal(stories[0].tags[0].text, "tools")
  assert.deepEqual(collector.parse(doc, { url: "https://example.com/" }), [])
})

test("applies an empty geny fallback before title processors", () => {
  const collector = require("../../../packages/collectors/dist/collectors/genyMatch")
  const doc = parseDocument(
    '<!doctype html><html><body><article><h2><a href="https://example.com/owner/repo">Repo</a></h2></article></body></html>'
  )
  const config = {
    stories: { sel: "article", all: true },
    link: { sel: "h2 a", component: "href" },
    title: {
      sel: "p.missing",
      component: "innerText",
      processors: ["trim", "show_path"],
      fallback: ""
    }
  }
  const stories = collector.parse(doc, { url: "https://example.com/", config })

  assert.equal(stories[0].title, "[owner/repo] ")
})

test("reports which required geny selector is empty", () => {
  const collector = require("../../../packages/collectors/dist/collectors/genyMatch")
  const doc = parseDocument(
    "<!doctype html><html><body><article></article></body></html>"
  )
  const config = (link, title) => ({
    stories: { sel: "article", all: true },
    link,
    title
  })

  assert.throws(
    () => collector.parse(doc, {
      url: "https://example.com/",
      config: config({ sel: ".missing" }, { fallback: "title" })
    }),
    /link selector produced an empty value/
  )
  assert.throws(
    () => collector.parse(doc, {
      url: "https://example.com/",
      config: config({ fallback: "https://example.com" }, { sel: ".missing" })
    }),
    /title selector produced an empty value/
  )
})

// Unreadable JSON is now caught while reading the legacy line, not here — see
// tests/unit/core/legacy-source-lines.test.js. What reaches a collector is
// already-parsed data, so what it has to reject is the wrong *shape*.
test("both configurable collectors reject configuration of the wrong shape", () => {
  const jsonCollector = require("../../../packages/collectors/dist/collectors/jsonSelect")
  const htmlCollector = require("../../../packages/collectors/dist/collectors/genyMatch")
  const doc = parseDocument("<main></main>")

  assert.throws(
    () => jsonCollector.parse({}, { url: "https://example.com/feed.json", config: { nope: {} } }),
    /json_select config nope is not a known field/
  )
  assert.throws(
    () => htmlCollector.parse(doc, { url: "https://example.com/", config: { nope: {} } }),
    /geny_match config nope is not a known field/
  )
  // jsonSelect had no validation at all before: its configuration arrived as
  // JSON embedded in a source line and went straight to the selector engine.
  assert.throws(
    () => jsonCollector.parse({}, { url: "https://example.com/feed.json", config: "nonsense" }),
    /json_select config must be an object/
  )
})
