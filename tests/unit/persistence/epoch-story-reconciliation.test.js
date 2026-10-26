const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const { reconcileEpoch } = require("../../../packages/persistence/dist/ReconcileEpoch")
const { reconcileEpochStory } = require("../../../packages/persistence/dist/EpochStoryReconciliation")

const id = "sto_https://servo.org/blog/2026/10/09/august-in-servo/"
const story = { _id: id, href: id.slice(4), title: "August in Servo", type: "rss", timestamp: 1,
  comment_url: "", tags: [], substories: [], read_state: "unread", stared: false, filter: "" }
const attachment = text => ({ content: { content_type: "text/html", data: Buffer.from(text).toString("base64") } })

async function fixture(t, localDoc, remoteDoc) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-epoch-story-"))
  const [local, remote, previous, target] = ["local", "remote", "previous", "target"].map(name => new PouchDB(path.join(directory, name)))
  t.after(async () => { await Promise.all([local, remote, previous, target].map(db => db.destroy())); await fs.rmdir(directory) })
  await local.bulkDocs([{ ...story, _rev: "1-local", ...localDoc }], { new_edits: false })
  await remote.bulkDocs([{ ...story, _rev: "1-remote", ...remoteDoc }], { new_edits: false })
  const migrate = () => reconcileEpoch(local, remote, previous, target, "test", () => {})
  return { local, remote, previous, target, migrate }
}

test("legacy first observation survives epoch reconciliation with canonical parsed metadata", async t => {
  const f = await fixture(t, { timestamp: 99, title: "Other parse", ingested_at: 100 }, {})
  const before = (await f.remote.info()).update_seq
  await f.migrate()
  const result = await f.target.get(id, { conflicts: true })
  assert.equal(result.ingested_at, 100)
  assert.equal(result.title, story.title)
  assert.equal(result._conflicts, undefined)
  assert.equal((await f.remote.info()).update_seq, before)
  assert.equal((await f.local.get(id)).title, "Other parse")
})

test("divergent stories merge user state, discussions and meaningful source associations onto the canonical branch", async t => {
  const tag = { class: "source", href: "https://servo.org/blog/", text: "Servo" }
  const f = await fixture(t, { read_state: "read", stared: true, sync_updated_at: { read_state: 20, stared: 20 },
    comment_url: "https://news.ycombinator.com/item?id=123", tags: [tag] },
  { read_state: "unread", sync_updated_at: { read_state: 10 }, title: "Canonical title" })
  await f.migrate()
  const result = await f.target.get(id, { conflicts: true, revs: true })
  assert.equal(result.read_state, "read")
  assert.equal(result.stared, true)
  assert.equal(result.title, "Canonical title")
  assert.equal(result.substories[0].comment_url, "https://news.ycombinator.com/item?id=123")
  assert.deepEqual(result.substories[0].tags, [tag])
  assert.ok(result._revisions.ids.includes("remote"))
  assert.equal(result._conflicts, undefined)
  const rev = result._rev
  await f.migrate()
  assert.equal((await f.target.get(id))._rev, rev, "retry is idempotent")
})

test("all live story branches contribute user edits", async t => {
  const f = await fixture(t, { stared: true }, {})
  await f.local.bulkDocs([{ ...story, _rev: "1-other", read_state: "read" }], { new_edits: false })
  await f.migrate()
  const result = await f.target.get(id, { conflicts: true })
  assert.equal(result.read_state, "read")
  assert.equal(result.stared, true)
  assert.equal(result._conflicts, undefined)
})

test("unique local saved content migrates with its metadata", async t => {
  const f = await fixture(t, { _attachments: attachment("saved locally"), stored_content: { source: "reader" } }, {})
  await f.migrate()
  const result = await f.target.get(id, { attachments: true })
  assert.equal(Buffer.from(result._attachments.content.data, "base64").toString(), "saved locally")
  assert.equal(result.stored_content.source, "reader")
})

test("different saved content is backed up and verified locally while canonical content stays active", async t => {
  const f = await fixture(t, { _attachments: attachment("local copy"), stored_content: { source: "reader" } },
    { _attachments: attachment("remote copy"), stored_content: { source: "feed" } })
  const backupIds = [], put = f.target.put.bind(f.target)
  f.target.put = doc => { if (doc._id.startsWith("_local/once-epoch-story-")) backupIds.push(doc._id); return put(doc) }
  await f.migrate()
  const result = await f.target.get(id, { attachments: true })
  assert.equal(result._rev, "1-remote")
  assert.equal(Buffer.from(result._attachments.content.data, "base64").toString(), "remote copy")
  assert.equal(backupIds.length, 1)
  const backup = await f.target.get(backupIds[0])
  assert.equal(Buffer.from(backup.original._attachments.content.data, "base64").toString(), "local copy")
  assert.equal(backup.original.stored_content.source, "reader")
  await f.migrate()
  assert.equal(backupIds.length, 1)
})

test("story integrity mismatch and cancelled session never write a merged story", async t => {
  const f = await fixture(t, { stared: true }, {})
  const doc = await f.local.get(id, { revs: true })
  await assert.rejects(reconcileEpochStory(f.local, f.previous, f.target, doc, { ...doc, title: "corruption" }, false, () => true), /same revision/)
  await assert.rejects(reconcileEpochStory(f.local, f.previous, f.target, doc, undefined, false, () => false), /session changed/)
  assert.equal((await f.target.info()).doc_count, 0)
})

test("a failed content backup prevents migration", async t => {
  const f = await fixture(t, { _attachments: attachment("local") }, { _attachments: attachment("remote") })
  const put = f.target.put.bind(f.target)
  f.target.put = doc => doc._id.startsWith("_local/once-epoch-story-") ? Promise.reject(new Error("Backup failed")) : put(doc)
  await assert.rejects(f.migrate(), /Backup failed/)
  assert.equal((await f.local.get(id))._rev, "1-local")
})
