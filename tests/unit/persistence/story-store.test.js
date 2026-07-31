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

test("preserves newer synchronized state when saving a stale story snapshot", async () => {
  const stored = new Story("rss", "https://example.com/story", "A story")
  stored._id = `sto_${stored.href}`
  stored._rev = "7-remote"
  stored.read_state = "skipped"
  stored.sync_updated_at = { read_state: 200 }
  const incoming = Story.from_obj({
    ...stored.to_obj(),
    _rev: "1-stale",
    read_state: "unread",
    sync_updated_at: undefined,
    tags: [{ class: "group", text: "*new", href: "search:*new" }]
  })
  let written
  const store = new PouchStoryStore(
    {
      get: async () => stored.to_obj(),
      put: async (doc) => {
        written = doc
        return { rev: "8-merged" }
      }
    },
    Story.from_obj.bind(Story)
  )

  const saved = await store.saveStory(incoming)

  assert.equal(written.read_state, "skipped")
  assert.deepEqual(written.sync_updated_at, { read_state: 200 })
  assert.deepEqual(written.tags, incoming.tags)
  assert.equal(saved._rev, "8-merged")
})

test("does not create a revision when the reconciled story is unchanged", async () => {
  const stored = new Story("rss", "https://example.com/story", "A story")
  stored._id = `sto_${stored.href}`
  stored._rev = "7-current"
  stored.read_state = "read"
  stored.sync_updated_at = { read_state: 200 }
  let writes = 0
  const store = new PouchStoryStore(
    {
      get: async () => stored.to_obj(),
      put: async () => {
        writes++
        return { rev: "unexpected" }
      }
    },
    Story.from_obj.bind(Story)
  )

  const saved = await store.saveStory(Story.from_obj(stored.to_obj()))

  assert.equal(writes, 0)
  assert.equal(saved._rev, "7-current")
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

test("loads stared stories through an indexed query", async () => {
  const stared = new Story("rss", "https://example.com/stared", "Stared")
  stared.stared = true
  const calls = []
  const store = new PouchStoryStore(
    {
      createIndex: async (options) => calls.push(["createIndex", options]),
      getIndexes: async () => ({
        indexes: [
          {
            ddoc: null,
            name: "_all_docs",
            type: "special",
            def: { fields: [{ _id: "asc" }] }
          },
          {
            ddoc: "_design/idx-legacy",
            name: "idx-legacy",
            type: "json",
            def: { fields: [{ stared: "asc" }] }
          },
          {
            ddoc: "_design/once-stared",
            name: "stared-only",
            type: "json",
            def: { fields: [{ stared: "asc" }] }
          }
        ]
      }),
      deleteIndex: async (index) => calls.push(["deleteIndex", index]),
      viewCleanup: async () => calls.push(["viewCleanup"]),
      find: async (options) => {
        calls.push(["find", options])
        return { docs: [stared.to_obj()] }
      }
    },
    Story.from_obj.bind(Story)
  )

  const stories = await store.getStaredStories()
  await store.getStaredStories()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(calls.filter(([name]) => name === "createIndex"), [[
    "createIndex",
    {
      index: {
        fields: ["stared"],
        partial_filter_selector: { stared: { $eq: true } }
      },
      ddoc: "once-stared",
      name: "stared-only"
    }
  ]])
  assert.deepEqual(calls.filter(([name]) => name === "find"), [
    ["find", {
      selector: { stared: { $eq: true } },
      use_index: ["once-stared", "stared-only"]
    }],
    ["find", {
      selector: { stared: { $eq: true } },
      use_index: ["once-stared", "stared-only"]
    }]
  ])
  assert.deepEqual(calls.filter(([name]) => name === "deleteIndex"), [[
    "deleteIndex",
    {
      ddoc: "_design/idx-legacy",
      name: "idx-legacy",
      type: "json"
    }
  ]])
  assert.ok(calls.some(([name]) => name === "viewCleanup"))
  assert.deepEqual(stories.map((story) => story.href), [stared.href])
})
