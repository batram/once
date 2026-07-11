const assert = require("node:assert/strict")

function assertStory(story, type) {
  assert.equal(story.type, type)
  assert.equal(typeof story.title, "string")
  assert.ok(story.title.trim(), "story title must not be empty")
  assert.doesNotThrow(() => new URL(story.href))
  assert.ok(Number.isFinite(Number(story.timestamp)), "timestamp must be finite")
  if (story.comment_url) assert.doesNotThrow(() => new URL(story.comment_url))
  for (const tag of story.tags || []) {
    assert.equal(typeof tag.class, "string")
    assert.equal(typeof tag.text, "string")
    assert.ok(tag.text.trim(), "tag text must not be empty")
    if (tag.href) assert.doesNotThrow(() => new URL(tag.href))
  }
}

function assertStories(stories, type, minimum = 1) {
  assert.ok(Array.isArray(stories))
  assert.ok(stories.length >= minimum, `expected at least ${minimum} stories`)
  stories.forEach((story) => assertStory(story, type))
}

module.exports = { assertStory, assertStories }
