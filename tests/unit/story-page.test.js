const test = require("node:test")
const assert = require("node:assert/strict")
const { Story, storyPageUrls, sameStoryDocument } = require("../../packages/core/dist")
const { ReadingSession } = require("../../packages/ui-web/dist/ReadingSession")
const { StoryWorkingSet } = require("../../packages/app/dist/StoryWorkingSet")

const original = "https://git.btxx.org/grubby"
const destination = "https://git.btxx.org/grubby/"

test("document matching ignores fragments but preserves queries and paths", () => {
  const story = new Story("fixture", original + "#intro", "Grubby", "https://example.test/comments?id=1")
  assert.equal(story.matches_url(original + "#install"), true)
  assert.equal(story.matches_url("https://example.test/comments?id=1#reply"), true)
  assert.equal(story.matches_url(original + "?other=1"), false)
  assert.equal(story.matches_url(destination), false, "a slash is an alias only after an observed redirect")
  const working = new StoryWorkingSet(() => {}, () => {}, () => {})
  working.set(story.href, story)
  assert.equal(working.lookup(original + "#install"), story)
  assert.equal(sameStoryDocument("https://example.test/a?q=1", "https://example.test/a?q=2"), false)
})

test("successful redirect and same-document provenance is bounded by errors", () => {
  assert.deepEqual(storyPageUrls(destination + "#install", { sourceUrl: original, statusCode: 200 }), [destination + "#install", original])
  assert.deepEqual(storyPageUrls("http://example.test/final", { sourceUrl: original, statusCode: 200 }), ["http://example.test/final", original])
  for (const statusCode of [404, 410, 500, 503]) {
    assert.deepEqual(storyPageUrls(destination, { sourceUrl: original, statusCode }), [])
  }
  assert.deepEqual(storyPageUrls(original, { failed: true }), [])
  assert.deepEqual(storyPageUrls("https://example.test/404", { sourceUrl: original, statusCode: 200 }), [])
  assert.deepEqual(storyPageUrls("https://example.test/error", { sourceUrl: original, statusCode: 200 }), [])
  assert.deepEqual(storyPageUrls("https://example.test/error-handling", { sourceUrl: original, statusCode: 200 }), ["https://example.test/error-handling", original])
  assert.deepEqual(storyPageUrls("https://example.test/unrelated"), ["https://example.test/unrelated"])
})

test("mobile carries a redirect's original story through hash/history changes, but not a new document", () => {
  const story = new Story("fixture", original, "Grubby", "https://example.test/comments")
  const session = new ReadingSession()
  session.open(story, "browser")
  session.navigationStarted(1, original)
  session.navigationCommitted(1, destination, false, { statusCode: 200 })
  session.navigationFinished(1, destination)
  session.historyChanged(1, destination + "#install", true)
  let state = session.snapshot()
  assert.equal(storyPageUrls(state.currentUrl, state.pageContext).some(url => story.matches_url(url)), true)
  session.navigationStarted(2, "https://example.test/unrelated")
  session.navigationFinished(2, "https://example.test/unrelated", { statusCode: 200 })
  state = session.snapshot()
  assert.equal(storyPageUrls(state.currentUrl, state.pageContext).some(url => story.matches_url(url)), false)
  session.navigationStarted(3, original)
  session.navigationCommitted(3, destination, false, { statusCode: 404 })
  state = session.snapshot()
  assert.deepEqual(storyPageUrls(state.currentUrl, state.pageContext), [])
})
