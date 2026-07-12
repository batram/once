const test = require("node:test")
const assert = require("node:assert/strict")
const { Story } = require("../../../packages/core/dist")
const { PouchStoryStore } = require("../../../packages/persistence/dist")

test("treats only a missing PouchDB story as an empty lookup", async () => {
  const missingStore = new PouchStoryStore(
    { get: async () => { throw { status: 404 } } },
    Story.from_obj.bind(Story)
  )
  assert.equal(await missingStore.getStory("https://example.com/missing"), null)

  const failedStore = new PouchStoryStore(
    { get: async () => { throw new Error("database unavailable") } },
    Story.from_obj.bind(Story)
  )
  await assert.rejects(
    failedStore.getStory("https://example.com/failure"),
    /database unavailable/
  )
})

test("rejects PouchDB save failures instead of reporting success", async () => {
  const store = new PouchStoryStore(
    { get: async () => { throw new Error("disk full") } },
    Story.from_obj.bind(Story)
  )
  const story = new Story("rss", "https://example.com/story", "A story")

  await assert.rejects(store.saveStory(story), /disk full/)
})
