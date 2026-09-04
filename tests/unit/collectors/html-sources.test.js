const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { parseDocument } = require("../../helpers/dom")
const { assertStories } = require("../../helpers/collector-contract")

const fixture = (name) => fs.readFileSync(path.resolve(__dirname, `../../fixtures/collectors/${name}`), "utf8")

test("parses Hacker News stories, users, times, and job filtering", () => {
  const collector = require("../../../packages/collectors/dist/collectors/hackerNewsHtml")
  const stories = collector.parse(parseDocument(fixture("hackernews.html")))
  assertStories(stories, "HN", 3)
  assert.equal(stories[0].tags[0].text, "alice")
  assert.equal(stories[1].filter, ":: HN ads ::")
  assert.equal(stories[2].href, "https://news.ycombinator.com/item?id=44")
})

test("parses Lobsters stories and skips entries without links", () => {
  const collector = require("../../../packages/collectors/dist/collectors/lobstersHtml")
  const stories = collector.parse(parseDocument(fixture("lobsters.html")))
  assertStories(stories, "LO")
  assert.equal(stories.length, 2)
  assert.equal(stories[0].timestamp, 1700000000000)
  assert.deepEqual(stories[0].tags.map((tag) => tag.text), ["bob", "security"])
  assert.equal(stories[1].href, "https://lobste.rs/s/self42/ask_lobsters")
})
