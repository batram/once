const test = require("node:test")
const assert = require("node:assert/strict")
const { Story } = require("../../../packages/core/dist")
const { ReadingSession } = require("../../../packages/ui-web/dist/ReadingSession")

function story(id) {
  return new Story(
    "EX",
    `https://example.test/${id}`,
    `Story ${id}`,
    `https://example.test/${id}/comments`,
    Date.now()
  )
}

test("ReadingSession centralizes modes and visible-story traversal", () => {
  const stories = [story("one"), story("two"), story("three")]
  const session = new ReadingSession()
  session.setVisibleStories(stories)
  session.open(stories[1], "comments")

  assert.equal(session.snapshot().currentUrl, stories[1].comment_url)
  assert.equal(session.snapshot().visibleStoryIndex, 1)
  assert.equal(session.move(-1), stories[0])
  assert.equal(session.snapshot().mode, "comments")
  assert.equal(session.move(-1), null)
})

test("ReadingSession ignores stale native events and closes a vanished story", () => {
  const active = story("active")
  const session = new ReadingSession()
  session.setVisibleStories([active])
  session.open(active, "browser")
  session.navigationStarted(4, active.href)
  session.navigationFinished(3, "https://stale.test/")
  assert.equal(session.snapshot().currentUrl, active.href)
  assert.equal(session.snapshot().loadState, "loading")

  session.navigationFinished(4, active.href)
  assert.equal(session.snapshot().loadState, "ready")
  session.setVisibleStories([])
  assert.equal(session.snapshot().story, null)
  assert.equal(session.snapshot().loadState, "idle")
})
