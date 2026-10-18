const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const {
  activeLocalDatabaseName,
  censusRevisions,
  copyWinningRevisions,
  EpochCopyDivergedError,
  LocalDatabaseEpoch,
  verifyWinningRevisions
} = require("../../../packages/persistence/dist")

async function databases(t, ...names) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "once-epoch-"))
  const dbs = names.map(name => new PouchDB(path.join(dir, name)))
  t.after(async () => {
    await Promise.all(dbs.map(db => db.close()))
    await fs.rm(dir, { recursive: true, force: true })
  })
  return dbs
}

/**
 * A server shaped like the real one: a story two devices created
 * independently, its losing branch deleted by conflict maintenance, a
 * document deleted outright, and a story with an article attachment.
 */
async function bloatedServer(server, phone, desktop) {
  await phone.put({ _id: "sto_a", title: "A", device: "phone" })
  await desktop.put({ _id: "sto_a", title: "A", device: "desktop" })
  await phone.replicate.to(server)
  await desktop.replicate.to(server)
  const winner = await server.get("sto_a", { conflicts: true })
  await server.bulkDocs(winner._conflicts.map(rev => ({ _id: "sto_a", _rev: rev, _deleted: true })))

  const gone = await server.put({ _id: "tsend_old", to: "phone" })
  await server.remove("tsend_old", gone.rev)

  await server.put({
    _id: "sto_b",
    title: "B",
    _attachments: { content: { content_type: "text/html", data: Buffer.from("<p>B</p>").toString("base64") } }
  })
  await server.replicate.to(phone)
  await server.replicate.to(desktop)
}

test("a winners-only copy keeps every winner and drops losing branches", async t => {
  const [server, phone, desktop, epoch] = await databases(t, "server", "phone", "desktop", "epoch")
  await bloatedServer(server, phone, desktop)

  const before = await censusRevisions(server)
  assert.equal(before.documents, 3)
  assert.equal(before.deletedDocuments, 1)
  assert.equal(before.extraLeaves, 1, "the deleted losing branch of sto_a")

  const result = await copyWinningRevisions(server, epoch, "server")
  assert.equal(result.copied, 3)

  const after = await censusRevisions(epoch)
  assert.equal(after.extraLeaves, 0)
  assert.equal(after.deletedDocuments, 1, "deleted documents move as tombstones")
  assert.deepEqual(await verifyWinningRevisions(server, epoch), { ok: true, mismatched: [], conflicted: [], extra: [] })

  const copied = await epoch.get("sto_b", { attachments: true })
  assert.equal(Buffer.from(copied._attachments.content.data, "base64").toString(), "<p>B</p>")
  const original = await server.get("sto_a", { revs: true })
  const kept = await epoch.get("sto_a", { revs: true })
  assert.deepEqual(kept._revisions, original._revisions, "the winner keeps its ancestry")
})

test("a replica's pending edit fast-forwards onto the copy instead of conflicting", async t => {
  const [server, phone, desktop, epoch, rebuilt] = await databases(t, "server", "phone", "desktop", "epoch", "rebuilt")
  await bloatedServer(server, phone, desktop)
  await copyWinningRevisions(server, epoch, "server")

  // Offline on the phone after its last sync: an edit, and a live copy of
  // a document the server since deleted.
  const story = await phone.get("sto_a")
  await phone.put({ ...story, read_state: "read" })
  // The phone moves to the epoch by rebuilding its own database the same way.
  await copyWinningRevisions(phone, rebuilt, "phone")
  await rebuilt.replicate.to(epoch)
  await epoch.replicate.to(rebuilt)

  const merged = await epoch.get("sto_a", { conflicts: true, deleted_conflicts: true })
  assert.equal(merged.read_state, "read")
  assert.equal(merged._conflicts, undefined)
  assert.equal(merged._deleted_conflicts, undefined)
  assert.equal((await censusRevisions(epoch)).extraLeaves, 0)
  await assert.rejects(rebuilt.get("tsend_old"), { status: 404, reason: "deleted" })
})

test("a second run copies only what changed, and verification names drift", async t => {
  const [server, phone, desktop, epoch] = await databases(t, "server", "phone", "desktop", "epoch")
  await bloatedServer(server, phone, desktop)
  await copyWinningRevisions(server, epoch, "server")

  const story = await server.get("sto_b")
  await server.put({ ...story, title: "B, edited" })
  const drift = await verifyWinningRevisions(server, epoch)
  assert.equal(drift.ok, false)
  assert.deepEqual(drift.mismatched, ["sto_b"])

  const again = await copyWinningRevisions(server, epoch, "server")
  assert.equal(again.copied, 1)
  assert.equal((await verifyWinningRevisions(server, epoch)).ok, true)
})

/** After a first copy, replication brings a longer, unrelated branch that now wins. */
async function flipWinner(source, other) {
  await other.put({ _id: "sto_flip", side: "b" })
  const b = await other.get("sto_flip")
  await other.put({ ...b, side: "b2" })
  await other.replicate.to(source)
  assert.equal((await source.get("sto_flip")).side, "b2", "the longer branch wins")
}

test("a resumed copy refuses a winner that switched branches instead of keeping both", async t => {
  const [server, other, target, fresh] = await databases(t, "server", "other", "target", "fresh")
  await server.put({ _id: "sto_flip", side: "a" })
  await copyWinningRevisions(server, target, "server")
  await flipWinner(server, other)

  await assert.rejects(copyWinningRevisions(server, target, "server"), error =>
    error instanceof EpochCopyDivergedError && error.ids.includes("sto_flip"))
  assert.equal((await censusRevisions(target)).extraLeaves, 0, "nothing of the new branch was written")
  await copyWinningRevisions(server, fresh, "server")
  assert.equal((await verifyWinningRevisions(server, fresh)).ok, true, "an empty target takes the copy")
})

test("a local rebuild interrupted before a branch switch starts its copy over", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "once-epoch-rebuild-"))
  const opened = []
  const open = name => { const db = new PouchDB(name); opened.push(db); return db }
  t.after(async () => { await Promise.all(opened.map(db => db.close().catch(() => undefined))); await fs.rm(dir, { recursive: true, force: true }) })
  const base = path.join(dir, "phone")
  const local = open(base), other = open(path.join(dir, "other"))
  await local.put({ _id: "sto_flip", side: "a" })
  // An earlier rebuild copied branch a, then the app stopped.
  const interrupted = new PouchDB(`${base}@once_e2`)
  await copyWinningRevisions(local, interrupted, `local:${base}`)
  await interrupted.close()
  await flipWinner(local, other)

  const storage = new Map()
  const pointer = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  const epoch = new LocalDatabaseEpoch(base, base, local, open, () => {}, pointer)
  await epoch.rebuild("https://couch.test/once_e2")

  const rebuilt = opened.at(-1)
  assert.equal(rebuilt.name, `${base}@once_e2`)
  assert.equal((await rebuilt.get("sto_flip")).side, "b2")
  assert.equal((await censusRevisions(rebuilt)).extraLeaves, 0, "only the current winner, not both branches")
  assert.equal(activeLocalDatabaseName(base, pointer), `${base}@once_e2`)
})

test("excluded documents stay behind and do not count as drift", async t => {
  const [server, phone, desktop, epoch] = await databases(t, "server", "phone", "desktop", "epoch")
  await bloatedServer(server, phone, desktop)
  const exclude = id => id === "sto_b"
  const result = await copyWinningRevisions(server, epoch, "server", { exclude })
  assert.equal(result.skipped, 1)
  await assert.rejects(epoch.get("sto_b"), { status: 404 })
  assert.equal((await verifyWinningRevisions(server, epoch, { exclude })).ok, true)
})
