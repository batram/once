const test = require("node:test")
const assert = require("node:assert/strict")

test("story-list sync subscribes before replaying its working snapshot", () => {
  const { connectStoryListSync } = require(
    "../../../packages/ui-web/dist/story/storyListSync"
  )
  const { Story } = require("../../../packages/core/dist")
  const snapshotStory = new Story(
    "rss",
    "https://example.com/snapshot",
    "Snapshot story"
  )
  const arrivingStory = new Story(
    "rss",
    "https://example.com/arriving",
    "Arriving story"
  )
  const handlers = new Map()
  const client = {
    subscribe(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    getStorySnapshot() {
      handlers.get("storiesChanged")({
        stories: [arrivingStory],
        bucket: "stories"
      })
      return [snapshotStory]
    }
  }
  const additions = []
  const removals = []
  const updates = []
  const disconnect = connectStoryListSync(client, {
    addStories(stories, bucket, replace) {
      additions.push({ stories, bucket, replace })
    },
    updateStory(change) {
      updates.push(change)
    },
    removeStory(href) {
      removals.push(href)
    },
    settingsChanged() {},
    redirectsChanged() {}
  })

  assert.deepEqual(
    additions.flatMap(({ stories }) => stories.map(({ href }) => href)),
    [arrivingStory.href, snapshotStory.href]
  )
  assert.ok(additions.every(({ replace }) => replace === false))

  handlers.get("storyChanged")({
    story: { ...snapshotStory.to_obj(), read_state: "read" },
    path: [snapshotStory.href, "read_state"],
    value: "read",
    previousValue: "unread",
    name: null,
    animated: false
  })
  assert.ok(updates[0].story instanceof Story)

  handlers.get("storyRemoved")({ href: snapshotStory.href })
  assert.deepEqual(removals, [snapshotStory.href])

  disconnect()
  assert.equal(handlers.size, 0)
})
