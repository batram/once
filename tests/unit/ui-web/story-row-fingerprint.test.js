const test = require("node:test")
const assert = require("node:assert/strict")
const { Story } = require("../../../packages/core/dist")
const {
  storyRowFingerprint
} = require("../../../packages/ui-web/dist/story/storyRowFingerprint")

function story() {
  return new Story("rss", "https://example.com/a", "A story", "", 1000)
}

test("a re-announced story with only bookkeeping changes draws the same row", () => {
  const shown = story()
  const again = story()
  again._rev = "7-abc"
  again.sync_updated_at = { read_state: 5 }
  again._attachments = { "content.html": { data: "x".repeat(1000) } }

  assert.equal(storyRowFingerprint(again), storyRowFingerprint(shown))
})

test("a change the row shows draws a different row", () => {
  const shown = storyRowFingerprint(story())
  const changes = [
    (s) => { s.title = "Renamed" },
    (s) => { s.read_state = "read" },
    (s) => { s.stared = true },
    (s) => { s.tags.push({ class: "group", text: "*news", href: "search:*news" }) },
    (s) => { s.substories.push({ type: "hn", comment_url: "https://hn/1", timestamp: 1, tags: [] }) },
    (s) => { s.stored_content = { source: "page", saved_at: 1 } }
  ]
  for (const change of changes) {
    const changed = story()
    change(changed)
    assert.notEqual(storyRowFingerprint(changed), shown, change.toString())
  }
})

test("an instance mutated in place no longer matches what was drawn from it", () => {
  const held = story()
  const drawn = storyRowFingerprint(held)
  held.tags.push({ class: "group", text: "*news", href: "search:*news" })

  assert.notEqual(storyRowFingerprint(held), drawn)
})
