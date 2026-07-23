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

test("recovers a corrupted story and reports its stored document", async (t) => {
  t.mock.method(console, "error", () => {})

  const doc = {
    _id: "sto_https://example.com/corrupt",
    _rev: "1-test",
    type: "rss",
    href: "https://example.com/corrupt",
    timestamp: Date.now()
  }
  const store = new PouchStoryStore(
    { allDocs: async () => ({ rows: [{ doc }] }) },
    Story.from_obj.bind(Story)
  )
  const diagnostics = []
  store.onDiagnostic((error) => diagnostics.push(error))

  const stories = await store.getStories()

  assert.equal(stories[0].href, doc.href)
  assert.match(stories[0].title, /Corrupted story/)
  assert.equal(diagnostics[0].operation, "story.load")
  assert.equal(diagnostics[0].documentId, doc._id)
  assert.match(diagnostics[0].details, /Stored document/)
})
