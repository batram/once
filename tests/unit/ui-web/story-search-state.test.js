const test = require("node:test")
const assert = require("node:assert/strict")

const { adoptStoredStoryState } = require(
  "../../../packages/ui-web/dist/story/storySearchState"
)
const { Story } = require("../../../packages/core/dist")

function result() {
  const story = new Story("hn", "https://example.com/a", "Fresh title")
  story.tags = [{ text: "fresh" }]
  return story
}

test("a global search result takes the stored read state and star", () => {
  const stored = new Story("hn", "https://example.com/a", "Old title")
  stored.read_state = "skipped"
  stored.stared = true
  stored.sync_updated_at = { read_state: 5 }
  stored.stored_content = { source: "feed", saved_at: 1 }

  const story = adoptStoredStoryState(result(), stored)

  assert.equal(story.read_state, "skipped")
  assert.equal(story.stared, true)
  assert.deepEqual(story.sync_updated_at, { read_state: 5 })
  assert.deepEqual(story.stored_content, { source: "feed", saved_at: 1 })
  // The result keeps what the collector just returned.
  assert.equal(story.title, "Fresh title")
  assert.deepEqual(story.tags, [{ text: "fresh" }])
})

test("a result the store has never seen stays unread", () => {
  const story = adoptStoredStoryState(result(), null)
  assert.equal(story.read_state, "unread")
  assert.equal(story.stared, false)
  assert.equal(story.sync_updated_at, undefined)
})
