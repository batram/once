const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const { repairDocument } = require("../../../scripts/couch-repair")

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "once-repair-"))
  const db = new PouchDB(path.join(dir, "db"))
  t.after(async () => { await db.close(); await fs.rm(dir, { recursive: true, force: true }) })
  await db.bulkDocs([{ _id: "theme", _rev: "2-b", list: "system" }, { _id: "theme", _rev: "1-a", list: "dark" }], { new_edits: false })
  return { db, plan: { id: "theme", winner: "2-b", revisions: ["2-b", "1-a"] } }
}

test("repair archives every branch and retains current settings in a normal new revision", async t => {
  const { db, plan } = await fixture(t); const journal = []
  const result = await repairDocument(db, plan, async entry => journal.push(entry))
  assert.deepEqual(journal[0].branches.map(d => d.list), ["system", "dark"])
  assert.equal(result.retired, 1)
  const doc = await db.get("theme", { conflicts: true, deleted_conflicts: true })
  assert.equal(doc.list, "system"); assert.equal(doc._conflicts, undefined)
  assert.match(doc._rev, /^3-/)
  const leaves = await db.get("theme", { open_revs: "all" })
  assert.equal(leaves.filter(row => row.ok._deleted).length, 1)
})
test("archive failure makes no database changes", async t => {
  const { db, plan } = await fixture(t)
  await assert.rejects(repairDocument(db, plan, async () => { throw Error("disk full") }), /disk full/)
  assert.equal((await db.get("theme"))._rev, "2-b")
})
test("a stale plan never discards a new branch", async t => {
  const { db, plan } = await fixture(t)
  await db.put({ _id: "theme", _rev: "2-b", list: "light" })
  await assert.rejects(repairDocument(db, plan, async () => {}), /stale/)
})
test("an edit during archival is retained and stops the repair", async t => {
  const { db, plan } = await fixture(t)
  await assert.rejects(repairDocument(db, plan, async () => {
    await db.put({ _id: "theme", _rev: "2-b", list: "light" })
  }), /changed during archival/)
  assert.equal((await db.get("theme")).list, "light")
})
test("an unexpected attachment hash prevents writing", async t => {
  const { db, plan } = await fixture(t)
  plan.attachment = { name: "content", sha256: "wrong" }
  await assert.rejects(repairDocument(db, plan, async () => {}), /Missing repair attachment/)
  assert.equal((await db.get("theme"))._rev, "2-b")
})

test("a new conflict after the winner write is retained", async t => {
  const { db, plan } = await fixture(t)
  await assert.rejects(repairDocument(db, plan, async entry => {
    if (entry.written) await db.bulkDocs([{ _id: "theme", _rev: "1-c", list: "light" }], { new_edits: false })
  }), /Concurrent edit/)
  assert.equal((await db.get("theme", { conflicts: true }))._conflicts.length, 2)
})

test("content repair writes bytes and fingerprint together in a new revision", async t => {
  const { db } = await fixture(t)
  const bytes = Buffer.from("<p>preserved article</p>")
  const hash = require("node:crypto").createHash("sha256").update(bytes).digest("hex")
  const old = await db.put({ _id: "sto_a", stored_content: { source: "feed" }, _attachments: {
    content: { content_type: "text/html", data: bytes.toString("base64") }
  } })
  const plan = { id: "sto_a", winner: old.rev, revisions: [old.rev], attachment: { name: "content", sha256: hash, fingerprint: true } }
  await assert.rejects(repairDocument(db, { ...plan, attachment: { ...plan.attachment, sha256: "wrong" } }, async () => {}), /attachment changed/)
  assert.equal((await db.get("sto_a"))._rev, old.rev)
  await repairDocument(db, plan, async () => {})
  const next = await db.get("sto_a", { attachments: true })
  assert.equal(next.stored_content.fingerprint, `sha256:${hash}`)
  assert.equal(next._attachments.content.data, bytes.toString("base64"))
  assert.notEqual(next._rev, old.rev)
})
