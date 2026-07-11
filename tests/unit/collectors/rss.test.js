const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { parseDocument } = require("../../helpers/dom")
const { assertStories } = require("../../helpers/collector-contract")

const fixture = (name) => fs.readFileSync(path.resolve(__dirname, `../../fixtures/collectors/${name}`), "utf8")

test("parses RSS 2 and recovers a missing title from content", () => {
  const collector = require("../../../packages/collectors/dist/collectors/vanilla_rss")
  const previous = collector.options.settings.time_cut_off.value
  collector.options.settings.time_cut_off.value = 10000
  try {
    const stories = collector.parse(parseDocument(fixture("rss.xml"), "text/xml"))
    assertStories(stories, "RSS", 2)
    assert.match(stories[1].title, /recovered from content/)
  } finally {
    collector.options.settings.time_cut_off.value = previous
  }
})

test("parses Atom and filters old or timeless entries according to settings", () => {
  const collector = require("../../../packages/collectors/dist/collectors/vanilla_rss")
  const previous = collector.options.settings.time_cut_off.value
  collector.options.settings.time_cut_off.value = 10000
  try {
    const stories = collector.parse(parseDocument(fixture("atom.xml"), "text/xml"))
    assertStories(stories, "RSS")
    assert.equal(stories[0].title, "Atom story")
  } finally {
    collector.options.settings.time_cut_off.value = previous
  }
})

test("parses Reddit Atom entries", () => {
  const collector = require("../../../packages/collectors/dist/collectors/reddit_rss")
  const stories = collector.parse(parseDocument(fixture("reddit-atom.xml"), "text/xml"))
  assertStories(stories, "re")
  assert.equal(stories[0].title, "Reddit RSS story")
})
