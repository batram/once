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

test("ReadingSession keeps its story anchor during typed navigation", () => {
  const stories = [story("one"), story("two")]
  const session = new ReadingSession()
  session.setVisibleStories(stories)
  session.open(stories[0], "browser")

  session.navigate("https://elsewhere.test/page")
  assert.equal(session.snapshot().story, stories[0])
  session.navigationFinished(2, "https://elsewhere.test/page")

  session.setMode("reader")
  assert.equal(session.snapshot().currentUrl, "https://elsewhere.test/page")
  assert.equal(session.move(1), stories[1])
  assert.equal(session.snapshot().currentUrl, stories[1].href)
})

test("ReadingSession supports standalone URLs without a saved story", () => {
  const session = new ReadingSession()
  session.navigate("https://standalone.test/page")

  assert.equal(session.snapshot().story, null)
  assert.equal(session.snapshot().currentUrl, "https://standalone.test/page")
  assert.equal(session.snapshot().mode, "browser")
  assert.equal(session.snapshot().loadState, "loading")

  session.setMode("reader")
  assert.equal(session.snapshot().mode, "reader")
  assert.equal(session.snapshot().currentUrl, "https://standalone.test/page")

  session.close()
  session.navigationFinished(9, "https://late.test/")
  assert.equal(session.snapshot().currentUrl, "")
})

test("ReadingSession can restore an already-loaded browser from Reader mode", () => {
  const active = story("ready")
  const session = new ReadingSession()
  session.open(active, "browser")
  session.navigationFinished(1, active.href)
  session.setMode("reader")
  session.setMode("browser", true)

  assert.equal(session.snapshot().mode, "browser")
  assert.equal(session.snapshot().loadState, "ready")
  assert.equal(session.snapshot().currentUrl, active.href)
})
