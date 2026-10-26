const test = require("node:test")
const assert = require("node:assert/strict")
const { Story } = require("../../../packages/core/dist")
const { PouchStoryStore: RealPouchStoryStore } = require("../../../packages/persistence/dist")

// These article-write unit doubles already have observation metadata. Real
// sidecar persistence and replication are covered by story-ingestion-policy.
class PouchStoryStore extends RealPouchStoryStore {
  constructor(db, fromObj) {
    const allDocs = db.allDocs?.bind(db)
    super({ ...db, allDocs: async options => {
      if (options.startkey?.startsWith("obs_")) {
        const href = decodeURIComponent(options.startkey.slice(4, -1))
        return { rows: [{ doc: { href, ingested_at: 1 } }] }
      }
      return allDocs(options)
    } }, fromObj)
  }
}

test("bulk story lookup reads each URL once and retains all found stories", async () => {
  const first = new Story("rss", "https://example.com/first", "First")
  const second = new Story("rss", "https://example.com/second", "Second")
  const requests = []
  const store = new PouchStoryStore({ allDocs: async options => {
    requests.push(options)
    return { rows: [{ doc: first.to_obj() }, {}, { doc: second.to_obj() }] }
  } }, Story.from_obj.bind(Story))
  const result = await store.getStoriesByUrls([first.href, first.href, "https://example.com/missing", second.href])
  assert.deepEqual(requests, [{ include_docs: true, keys: [
    `sto_${first.href}`, "sto_https://example.com/missing", `sto_${second.href}`
  ] }])
  assert.deepEqual([...result.keys()], [first.href, second.href])
  assert.equal((await store.getStoriesByUrls([])).size, 0)
  assert.equal(requests.length, 1)
})

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

test("retries a new story whose document replication delivered mid-save", async (t) => {
  t.mock.method(console, "log", () => {})
  // Both devices ingest the same feed item; the other device's copy arrives
  // between the 404 and the create, so the create conflicts.
  const remote = new Story("rss", "https://example.com/story", "A story")
  remote._id = `sto_${remote.href}`
  remote._rev = "1-remote"
  remote.read_state = "read"
  remote.sync_updated_at = { read_state: 200 }
  remote.ingested_at = 100
  let stored = null
  const puts = []
  const store = new PouchStoryStore(
    {
      get: async () => {
        if (!stored) throw { status: 404 }
        return structuredClone(stored)
      },
      put: async (doc) => {
        puts.push(doc)
        if (!doc._rev) {
          stored = remote.to_obj()
          throw { status: 409, name: "conflict", message: "Document update conflict" }
        }
        return { rev: "2-merged" }
      }
    },
    Story.from_obj.bind(Story)
  )
  const incoming = new Story("rss", remote.href, "A story")
  incoming.tags = [{ class: "group", text: "*new", href: "search:*new" }]

  const saved = await store.saveStory(incoming)

  assert.equal(puts.length, 2)
  assert.equal(puts[1]._rev, "1-remote")
  assert.equal(puts[1].read_state, "read", "the replicated state survives")
  assert.equal(puts[1].ingested_at, 100, "the losing create's ingestion time is dropped")
  assert.equal(saved._rev, "2-merged")
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
      find: async (options) => {
        calls.push(["find", options])
        return { docs: [stared.to_obj()] }
      }
    },
    Story.from_obj.bind(Story)
  )

  const stories = await store.getStaredStories()
  await store.getStaredStories()

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
  assert.deepEqual(stories.map((story) => story.href), [stared.href])
})

const ARTICLE = "<p>Stored article — with a non-Latin-1 character: ✓</p>"

// A PouchDB stand-in that holds one document and its attachment the way the
// real one does: the document carries a stub, the bytes live beside it.
function createAttachmentDatabase(initial) {
  const state = { doc: initial ? { ...initial } : null, attachment: null, calls: [] }
  const notFound = () => Object.assign(new Error("missing"), { status: 404 })
  return {
    state,
    db: {
      async get(id) {
        state.calls.push(["get", id])
        if (!state.doc || state.doc._id !== id) throw notFound()
        return structuredClone(state.doc)
      },
      async put(doc) {
        state.calls.push(["put", structuredClone(doc)])
        const revision = Number((state.doc?._rev ?? "0-x").split("-")[0]) + 1
        state.doc = { ...doc, _rev: `${revision}-put` }
        if (doc._attachments?.content?.data) {
          state.attachment = new Blob([Buffer.from(doc._attachments.content.data, "base64")], { type: "text/html" })
          state.doc._attachments = { content: { content_type: "text/html", digest: "md5-fake", length: state.attachment.size, stub: true } }
        }
        return { rev: state.doc._rev }
      },
      async putAttachment(id, name, rev, attachment, type) {
        state.calls.push(["putAttachment", id, name, rev, type])
        assert.equal(state.doc._rev, rev, "attachments are written against the current revision")
        state.attachment = attachment
        const revision = Number(rev.split("-")[0]) + 1
        state.doc = {
          ...state.doc,
          _rev: `${revision}-att`,
          _attachments: { [name]: { content_type: type, digest: "md5-fake", length: attachment.size, stub: true } }
        }
        return { rev: state.doc._rev }
      },
      async getAttachment(id, name) {
        state.calls.push(["getAttachment", id, name])
        if (!state.attachment || state.doc?._id !== id || !state.doc._attachments?.[name]) throw notFound()
        return state.attachment
      }
    }
  }
}

test("writes pending html as the content attachment and keeps only its stub", async () => {
  const { db, state } = createAttachmentDatabase()
  const store = new PouchStoryStore(db, Story.from_obj.bind(Story))
  const story = new Story("rss", "https://example.com/story", "A story")
  story.attachContent(ARTICLE, { source: "feed", saved_at: 7 })

  const saved = await store.saveStory(story)

  assert.deepEqual(state.calls.map(([name]) => name), ["get", "put", "get"])
  const [, putDoc] = state.calls[1]
  assert.equal(Buffer.from(putDoc._attachments.content.data, "base64").toString(), ARTICLE, "the write includes its attachment")
  assert.deepEqual(putDoc.stored_content, { source: "feed", saved_at: 7, fingerprint: putDoc.stored_content.fingerprint })
  assert.match(putDoc.stored_content.fingerprint, /^sha256:[0-9a-f]{64}$/)
  assert.equal(await state.attachment.text(), ARTICLE)
  assert.equal(saved._rev, "1-put")
  assert.equal(saved.pendingContent(), undefined, "the html is not kept in memory")
  assert.equal(saved._attachments.content.stub, true)
  assert.equal(saved.has_content(), true)
  assert.equal(await store.getStoryContent(story.href), ARTICLE)
})

test("a plain save carries the stored attachment stubs and does not rewrite content", async () => {
  const { db, state } = createAttachmentDatabase()
  const store = new PouchStoryStore(db, Story.from_obj.bind(Story))
  const story = new Story("rss", "https://example.com/story", "A story")
  story.attachContent(ARTICLE, { source: "feed", saved_at: 7 })
  await store.saveStory(story)
  state.calls.length = 0

  // A snapshot from elsewhere: no attachment stubs, a changed field.
  const snapshot = Story.from_obj({ ...story.to_obj(), _attachments: undefined, read_state: "read" })
  await store.saveStory(snapshot)
  const putDoc = state.calls.find(([name]) => name === "put")[1]
  assert.equal(putDoc._attachments.content.stub, true, "a put without the stubs would drop the attachment")
  assert.equal(state.calls.some(([name]) => name === "putAttachment"), false)
  state.calls.length = 0

  // The same html arriving again (a feed reload) changes nothing.
  const again = Story.from_obj(story.to_obj())
  again.read_state = "read"
  again.attachContent(ARTICLE, { source: "feed", saved_at: 7 })
  const saved = await store.saveStory(again)
  assert.deepEqual(state.calls.map(([name]) => name), ["get", "getAttachment"])
  assert.equal(saved.pendingContent(), undefined)
  assert.equal(saved._attachments.content.stub, true)
})

test("newer content replaces the attachment", async () => {
  const { db, state } = createAttachmentDatabase()
  const store = new PouchStoryStore(db, Story.from_obj.bind(Story))
  const story = new Story("rss", "https://example.com/story", "A story")
  story.attachContent(ARTICLE, { source: "feed", saved_at: 7 })
  await store.saveStory(story)
  state.calls.length = 0

  story.attachContent("<p>From the page</p>", { source: "page", saved_at: 9, title: "Page" })
  const saved = await store.saveStory(story)
  assert.deepEqual(state.calls.map(([name]) => name), ["get", "put", "get"])
  assert.equal(await store.getStoryContent(story.href), "<p>From the page</p>")
  assert.equal(saved.contentSource(), "page")
})

test("getStoryContent reads null for a story without an attachment or a database without them", async () => {
  const { db } = createAttachmentDatabase({ _id: "sto_https://example.com/story", _rev: "1-x" })
  const store = new PouchStoryStore(db, Story.from_obj.bind(Story))
  assert.equal(await store.getStoryContent("https://example.com/story"), null)

  const plain = new PouchStoryStore({ get: async () => { throw { status: 404 } } }, Story.from_obj.bind(Story))
  assert.equal(await plain.getStoryContent("https://example.com/story"), null)
})
