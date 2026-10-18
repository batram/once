const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const { Story, storyDisplayTime, normalizeFeedContent } = require("../../../packages/core/dist")
const { PouchStoryStore, PouchMaintenanceService } = require("../../../packages/persistence/dist")

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-ingestion-policy-"))
  const db = new PouchDB(path.join(directory, "stories"))
  t.after(async () => { await db.close(); await fs.rm(directory, { recursive: true, force: true }) })
  return { db, store: new PouchStoryStore(db, Story.from_obj.bind(Story)) }
}
const item = (time = 0) => new Story("RSS", "https://example.test/story", "Original title", "https://example.test/comments", time)
const source = (name, href = `search:${name}`) => ({ class: "source", text: name, href })

test("new stories normalize time representations and never serialize local observation times", async t => {
  const { store } = await fixture(t)
  const a = item("2026-10-18T12:00:00Z")
  assert.equal(a.timestamp, Date.parse("2026-10-18T12:00:00Z"))
  const saved = await store.saveStory(a)
  const again = await store.saveStory(item(new Date(a.timestamp)))
  assert.equal(again._rev, saved._rev)
  const unknown = new Story("RSS", "https://example.test/unknown", "Unknown")
  assert.equal(unknown.timestamp, 0)
  assert.ok(storyDisplayTime(unknown) > 0)
  assert.equal(storyDisplayTime(unknown), storyDisplayTime(unknown))
  assert.equal(unknown.to_obj().timestamp, 0)
})

test("independent discovery with equivalent dates or no dates mints identical revisions", async t => {
  const a = await fixture(t), b = await fixture(t)
  const left = await a.store.saveStory(item("2026-10-18T12:00:00"))
  const right = await b.store.saveStory(item(Date.parse("2026-10-18T12:00:00Z")))
  assert.equal(left._rev, right._rev)
  const missing = () => new Story("RSS", "https://example.test/missing", "No source date")
  assert.equal((await a.store.saveStory(missing()))._rev, (await b.store.saveStory(missing()))._rev)
})

test("existing date representations and discussion timestamps are not rewritten by refresh", async t => {
  const { db, store } = await fixture(t)
  const doc = { ...item().to_obj(), _id: "sto_https://example.test/story", timestamp: "2026-10-18T12:00:00Z",
    substories: [{ type: "HN", comment_url: "https://other.test/discussion", timestamp: "2026-10-17T12:00:00Z", tags: [] }] }
  const before = await db.put(doc)
  const incoming = item(99999)
  incoming.substories = [{ ...doc.substories[0], timestamp: 88888 }]
  assert.equal((await store.saveStory(incoming))._rev, before.rev)
})

test("parsed differences and cosmetic source changes do not write, but new associations survive", async t => {
  const { db, store } = await fixture(t)
  const original = item(1000); original.tags = [source("A")]; original.author = "original author"
  const saved = await store.saveStory(original)
  const parsed = item(999999); parsed.title = "Different parsed title"; parsed.type = "different parser"
  parsed.tags = [source("renamed label", "search:A")]; parsed.author = "different author"
  const unchanged = await store.saveStory(parsed)
  assert.equal(unchanged._rev, saved._rev)
  const addition = item(888888); addition.comment_url = "https://other.test/discussion"; addition.tags = [source("B")]
  const extended = await store.saveStory(addition)
  const doc = await db.get(extended._id)
  assert.equal(doc.title, "Original title"); assert.equal(doc.timestamp, 1000)
  assert.deepEqual(doc.tags, [source("A")])
  assert.equal(doc.substories[0].comment_url, addition.substories[0].comment_url)
  const repeat = item(777777); repeat.comment_url = "https://other.test/discussion#reply"; repeat.tags = [source("B")]
  assert.equal((await store.saveStory(repeat))._rev, extended._rev)
})

test("stale user-state saves retain stored metadata and concurrent source additions", async t => {
  const { db, store } = await fixture(t)
  const saved = await store.saveStory(item(1000))
  const stale = Story.from_obj(saved.to_obj())
  const incoming = item(2000); incoming.tags = [source("new-source")]
  await store.saveStory(incoming)
  stale.title = "Stale parser title"; stale.timestamp = 3
  stale.stared = true; stale.sync_updated_at = { stared: 100 }
  await store.saveStory(stale)
  const doc = await db.get(saved._id)
  assert.equal(doc.stared, true); assert.equal(doc.title, "Original title"); assert.equal(doc.timestamp, 1000)
  assert.deepEqual(doc.tags, [source("new-source")])
})

test("repeated identical article saves ignore saved_at but preserve changed bytes", async t => {
  const { store } = await fixture(t)
  const a = item(1000); a.attachContent("<p>one</p>", { source: "feed", saved_at: 1000 })
  const first = await store.saveStory(a)
  const b = item(2000); b.attachContent("<p>one</p>", { source: "feed", saved_at: 2000 })
  assert.equal((await store.saveStory(b))._rev, first._rev)
  assert.equal(b.stored_content.saved_at, 1000)
  const c = item(3000); c.attachContent("<p>two</p>", { source: "feed", saved_at: 3000 })
  assert.notEqual((await store.saveStory(c))._rev, first._rev)
  assert.equal(await store.getStoryContent(a.href), "<p>two</p>")
})

test("derived filters change without clock stamps and repeated evaluation is a no-op", async t => {
  const { db, store } = await fixture(t)
  const a = item(); a.filter = "old"; a.sync_updated_at = { filter: 200, stared: 50 }
  await store.saveStory(a)
  a.filter = "new"
  const changed = await store.saveStory(a, { derivedFilter: true })
  const revision = changed._rev
  assert.deepEqual((await db.get(a._id)).sync_updated_at, { stared: 50, filter: 0 })
  assert.equal((await store.saveStory(a, { derivedFilter: true }))._rev, revision)
  const stale = item(); stale.filter = "old"; stale.sync_updated_at = { filter: 999999, stared: 50 }
  assert.equal((await store.saveStory(stale))._rev, revision)
  assert.equal(stale.filter, "new", "a stale window cannot revive a retired derived-filter clock")
})

test("maintenance keeps winner metadata and unions losing source associations", async t => {
  const { db } = await fixture(t)
  const base = item(1000).to_obj()
  await db.bulkDocs([
    { ...base, _id: "sto_test", _rev: "2-b", tags: [source("A")] },
    { ...base, _id: "sto_test", _rev: "1-a", title: "Other title", timestamp: 9000,
      comment_url: "https://other.test/discussion", tags: [source("B")] }
  ], { new_edits: false })
  const errors = []
  assert.equal(await new PouchMaintenanceService(db, () => {}, e => errors.push(e)).run(), true)
  assert.deepEqual(errors, [])
  const result = await db.get("sto_test", { conflicts: true })
  assert.equal(result.title, "Original title"); assert.equal(result.timestamp, 1000)
  assert.equal(result._conflicts, undefined)
  assert.deepEqual(result.substories[0].tags, [source("B")])
})

test("maintenance retires parser-only duplicates without rewriting the winner", async t => {
  const { db } = await fixture(t)
  const base = item(1000).to_obj()
  await db.bulkDocs([
    { ...base, _id: "sto_test", _rev: "2-b" },
    { ...base, _id: "sto_test", _rev: "1-a", title: "Cosmetic title", timestamp: 2000 }
  ], { new_edits: false })
  await new PouchMaintenanceService(db, () => {}, e => { throw e }).run()
  const result = await db.get("sto_test", { conflicts: true })
  assert.equal(result._rev, "2-b")
  assert.equal(result._conflicts, undefined)
})

test("maintenance leaves distinct saved attachment bytes available for explicit resolution", async t => {
  const { db } = await fixture(t)
  const base = item().to_obj()
  await db.bulkDocs(["a", "b"].map(rev => ({ ...base, _id: "sto_test", _rev: `1-${rev}`,
    _attachments: { content: { content_type: "text/html", data: Buffer.from(rev).toString("base64") } }
  })), { new_edits: false })
  await new PouchMaintenanceService(db, () => {}, e => { throw e }).run()
  assert.equal((await db.get("sto_test", { conflicts: true }))._conflicts.length, 1)
})

test("feed normalization removes only hidden WordPress nonces and keeps page captures unchanged", () => {
  const volatile = '<input type="hidden" name="_wpnonce" value="random" />'
  const meaningful = '<p>Article</p><input name="_wpnonce" value="visible"><input type="hidden" name="other" value="keep">'
  assert.equal(normalizeFeedContent(meaningful + volatile), meaningful)
  assert.equal(normalizeFeedContent("<INPUT VALUE='random' NAME='_wpnonce' TYPE='HIDDEN'>"), "")
  assert.equal(normalizeFeedContent('<input data-note="name=\'_wpnonce\'" type="hidden" value="keep">'), '<input data-note="name=\'_wpnonce\'" type="hidden" value="keep">')
  const page = item(); page.attachContent(meaningful + volatile, { source: "page", saved_at: 1 })
  assert.equal(page.pendingContent(), meaningful + volatile)
  const feed = item(); feed.attachContent(meaningful + volatile, { source: "feed", saved_at: 1 })
  assert.equal(feed.pendingContent(), meaningful)
})

test("legacy feed branches differing only in hidden nonces settle without rewriting the winner", async t => {
  const { db } = await fixture(t)
  const base = item().to_obj()
  await db.bulkDocs(["a", "b"].map(rev => ({ ...base, _id: "sto_nonce", _rev: `1-${rev}`,
    stored_content: { source: "feed", saved_at: 1 },
    _attachments: { content: { content_type: "text/html", data: Buffer.from(`<p>Same article</p><input type="hidden" name="_wpnonce" value="${rev}">`).toString("base64") } }
  })), { new_edits: false })
  const before = await db.get("sto_nonce")
  await new PouchMaintenanceService(db, () => {}, e => { throw e }).run()
  const after = await db.get("sto_nonce", { conflicts: true })
  assert.equal(after._rev, before._rev)
  assert.equal(after._conflicts, undefined)
})
