const test = require("node:test")
const assert = require("node:assert/strict")
const collector = require("../../../packages/collectors/dist/collectors/reddit_json")
const { assertStories } = require("../../helpers/collector-contract")
const fixture = require("../../fixtures/collectors/reddit.json")

test("maps Reddit listings and applies the score threshold", () => {
  const stories = collector.parse(fixture)
  assertStories(stories, "re")
  assert.equal(stories.length, 1)
  assert.deepEqual(stories[0].tags.map(({ class: kind, text }) => [kind, text]), [["user", "alice"], ["channel", "/r/netsec"]])
  assert.equal(collector.parse(fixture, false).length, 2)
})

test("ignores unsupported listing kinds", () => {
  assert.deepEqual(collector.parse({ kind: "Thing", data: { children: [] } }), [])
})
