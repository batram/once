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

test("takes Hacker News times from the age title so every device stores the same time", () => {
  const collector = require("../../../packages/collectors/dist/collectors/hackerNewsHtml")
  const titled = ["2026-10-09T13:03:48 1791637428", "2026-10-09T13:16:33"]
  const html = fixture("hackernews.html")
    .replace(/<span class="age">/g, (span) => titled.length ? `<span class="age" title="${titled.shift()}">` : span)
  const stories = collector.parse(parseDocument(html))
  assert.equal(stories[0].timestamp, 1791637428000, "Unix seconds win when present")
  assert.equal(stories[1].timestamp, Date.parse("2026-10-09T13:16:33Z"), "the ISO time is UTC")
  const before = Date.now()
  assert.ok(stories[2].timestamp <= before - 3 * 3600 * 1000 + 60_000, "an untitled age still parses relatively")
})

test("parses Lobsters stories and skips entries without links", () => {
  const collector = require("../../../packages/collectors/dist/collectors/lobstersHtml")
  const stories = collector.parse(parseDocument(fixture("lobsters.html")))
  assertStories(stories, "LO")
  assert.equal(stories.length, 2)
  assert.equal(stories[0].timestamp, 1700000000000)
  assert.deepEqual(stories[0].tags.map((tag) => tag.text), ["bob", "security"])
  assert.equal(stories[1].href, "https://lobste.rs/s/self42/ask_lobsters")
  // The bare /s/<id> path can be a stale page-cache copy; prefer the slugged link.
  assert.equal(stories[0].comment_url, "https://lobste.rs/s/abc123/lobsters_story")
  assert.equal(stories[1].comment_url, "https://lobste.rs/s/self42")
})
