const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const PouchDB = require("pouchdb")
const couchServer = require("../../helpers/couch-server")
const { copyWinningRevisions, censusRevisions, verifyWinningRevisions, PouchStoryStore, PouchSyncService } = require("../../../packages/persistence/dist")
const { compactLocalRevisions } = require("../../../packages/persistence/dist/LocalCompaction")

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-db-performance-"))
  const handles = []
  const open = name => { const db = new PouchDB(path.join(directory, name)); handles.push(db); return db }
  t.after(async () => { for (const db of handles) await db.destroy(); await fs.rmdir(directory) })
  return { directory, open }
}

test("HTTP epoch pages stay bounded without falling back to 25-document transport pages", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-http-performance-"))
  const Db = PouchDB.defaults({ prefix: directory + path.sep })
  const api = couchServer(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const source = new Db("source"), target = new Db("target")
  await source.bulkDocs(Array.from({ length: 240 }, (_, i) => ({ _id: "sto_" + i, value: i })))
  await target.info()
  const http = await new Promise(resolve => { const s = api.listen(0, "127.0.0.1", () => resolve(s)) })
  const changes = []
  const fetch = (url, options) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith("/_changes")) changes.push(Object.fromEntries(parsed.searchParams))
    return PouchDB.fetch(url, options)
  }
  const base = `http://127.0.0.1:${http.address().port}`
  const a = new PouchDB(base + "/source", { skip_setup: true, fetch })
  const b = new PouchDB(base + "/target", { skip_setup: true, fetch })
  t.after(async () => {
    await a.close(); await b.close(); http.closeAllConnections()
    await new Promise(resolve => http.close(resolve))
    await source.destroy(); await target.destroy()
    // express-pouchdb retains its catalog handle until this test worker exits.
  })
  await copyWinningRevisions(a, b, "fixture", { batchSize: 100 })
  assert.equal(changes.length, 4)
  assert.ok(changes.every(row => row.limit === "100"))
  changes.length = 0
  const progress = []
  assert.equal((await verifyWinningRevisions(a, b, { batchSize: 100, onProgress: step => progress.push(step) })).ok, true)
  assert.equal(changes.length, 8, "one census per database, not two")
  assert.ok(changes.every(row => row.style === "all_docs" && row.limit === "100"))
  assert.deepEqual(progress.at(-1), { phase: "content", processed: 240, total: 240 })
})

test("one-pass census uses the actual winner rather than the first leaf", async () => {
  let calls = 0
  const db = { async changes() { return calls++ ? { results: [], last_seq: 2 } : {
    results: [
      { id: "sto_live", changes: [{ rev: "9-deleted" }, { rev: "1-live" }], doc: { _rev: "1-live" } },
      { id: "sto_gone", deleted: true, changes: [{ rev: "3-gone" }], doc: { _rev: "3-gone", _deleted: true } }
    ], last_seq: 2
  } } }
  const result = await censusRevisions(db)
  assert.deepEqual(result.winners.get("sto_live"), { rev: "1-live", deleted: false, leaves: 2 })
  assert.equal(result.deletedDocuments, 1)
  assert.equal(result.extraLeaves, 1)
  await assert.rejects(censusRevisions({ changes: async () => ({ results: [{ id: "missing", changes: [{ rev: "1-a" }] }], last_seq: 1 }) }), /census winner/)
  await assert.rejects(censusRevisions(db, 0), /positive integer/)
})

test("actual sync options exclude all controls in both directions without downloading changes bodies", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-selector-performance-"))
  const Db = PouchDB.defaults({ prefix: directory + path.sep })
  const api = couchServer(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const source = new Db("source"), local = new Db("local")
  await source.bulkDocs([{ _id: "once_sync_compat", schema: 1, minSyncProtocol: 4 },
    { _id: "_design/once-epoch-freeze", views: {} }, { _id: "sto_live", value: 1 }, { _id: "sto_deleted", value: 1 }])
  await source.remove(await source.get("sto_deleted"))
  const http = await new Promise(resolve => { const s = api.listen(0, "127.0.0.1", () => resolve(s)) })
  const url = `http://127.0.0.1:${http.address().port}/source`, requests = []
  const remote = new PouchDB(url, { skip_setup: true, fetch: (url, options) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith("/_changes")) requests.push(Object.fromEntries(parsed.searchParams))
    return PouchDB.fetch(url, options)
  } })
  const sync = local.sync.bind(local)
  let options
  local.sync = (target, passed) => { options = passed; return sync(target, passed) }
  const service = new PouchSyncService(local, () => {}, () => remote)
  t.after(async () => {
    service.syncFrom(""); await remote.close(); http.closeAllConnections()
    await new Promise(resolve => http.close(resolve)); await source.destroy(); await local.destroy()
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sync did not settle")), 5000)
    service.onStatus(status => {
      if (status.state === "up-to-date" && options) { clearTimeout(timer); resolve() }
      if (status.state === "error") { clearTimeout(timer); reject(new Error(status.message)) }
    })
    service.syncFrom(url)
  })
  service.syncFrom("")
  await source.put({ _id: "once_sync_epoch", schema: 1, state: "ready", next: "next_epoch" })
  await local.replicate.from(remote, { ...options, live: false })
  for (const id of ["once_sync_compat", "once_sync_epoch", "_design/once-epoch-freeze"]) await assert.rejects(local.get(id), { status: 404 })
  assert.equal((await local.allDocs({ keys: ["sto_deleted"] })).rows[0].value.deleted, true)
  await local.bulkDocs([{ _id: "once_sync_compat", schema: 1, minSyncProtocol: 99 }, { _id: "sto_local", value: 2 }])
  await local.replicate.to(remote, { ...options, live: false })
  assert.equal((await source.get("once_sync_compat")).minSyncProtocol, 4)
  assert.equal((await source.get("sto_local")).value, 2)
  assert.ok(requests.some(row => row.filter === "_selector"))
  assert.ok(requests.filter(row => row.filter === "_selector").every(row => row.include_docs !== "true"))
})

test("compaction skips empty work but removes available ancestors without removing losing leaves or attachments", async t => {
  const { open } = await fixture(t), db = open("compaction")
  await db.put({ _id: "sto_history", value: 1 })
  const old = await db.get("sto_history")
  await db.put({ ...old, value: 2, _attachments: { content: { content_type: "text/plain", data: "c2F2ZWQ=" } } })
  await db.bulkDocs([{ _id: "sto_history", _rev: "1-obsolete", _deleted: true }], { new_edits: false })
  await db.put({ _id: "sto_clean", value: 1 })
  const before = await censusRevisions(db)
  const compact = db._doCompaction.bind(db), calls = []
  db._doCompaction = (id, revisions, callback) => { calls.push({ id, revisions }); return compact(id, revisions, callback) }
  assert.equal(await compactLocalRevisions(db, () => true, () => {}), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, "sto_history")
  assert.ok(calls[0].revisions.includes(old._rev))
  const after = await censusRevisions(db)
  assert.deepEqual(after.winners, before.winners)
  assert.equal((await db.getAttachment("sto_history", "content")).toString(), "saved")
  await assert.rejects(db.get("sto_history", { rev: old._rev }), { status: 404 })
  calls.length = 0
  await compactLocalRevisions(db, () => true, () => {})
  assert.equal(calls.length, 0, "completed scan resumes at its checkpoint")
})

test("cancelled compaction leaves an incomplete batch uncheckpointed and bounds concurrent metadata reads", async () => {
  let active = 0, peak = 0, reads = 0, current = true
  const writes = []
  const db = {
    get: async () => { throw { status: 404 } },
    put: async doc => { writes.push(doc); return { rev: "0-1" } },
    changes: async () => ({ results: Array.from({ length: 100 }, (_, i) => ({ id: "sto_" + i })), last_seq: 100 }),
    _getRevisionTree(_id, callback) {
      peak = Math.max(peak, ++active)
      setTimeout(() => { active--; if (++reads === 12) current = false; callback(null, [{ ids: ["leaf", { status: "available" }, []] }]) }, 1)
    },
    compactDocument: async () => assert.fail("A leaf alone has nothing to compact")
  }
  assert.equal(await compactLocalRevisions(db, () => current, () => {}), false)
  assert.ok(peak <= 8)
  assert.equal(active, 0, "all in-flight workers have settled")
  assert.equal(writes.length, 0)
})

test("a compaction read failure stops new work and drains readers before returning", async () => {
  let active = 0, started = 0, writes = 0
  const db = {
    get: async () => { throw { status: 404 } },
    put: async () => { writes++; return { rev: "0-1" } },
    changes: async () => ({ results: Array.from({ length: 100 }, (_, i) => ({ id: "sto_" + i })), last_seq: 100 }),
    _getRevisionTree(id, callback) {
      active++; started++
      setTimeout(() => {
        active--
        if (id === "sto_0") callback(new Error("storage unavailable"))
        else callback(null, [{ ids: ["parent", { status: "available" }, [["leaf", { status: "available" }, []]]] }])
      }, id === "sto_0" ? 0 : 5)
    },
    compactDocument: async () => { writes++ }
  }
  await assert.rejects(compactLocalRevisions(db, () => true, () => {}), /storage unavailable/)
  assert.equal(active, 0)
  assert.ok(started <= 8)
  assert.equal(writes, 0)
})

test("starred projection returns more than 25 bookmarks and incrementally handles edits and deletes", async t => {
  const { open } = await fixture(t), db = open("starred")
  await db.bulkDocs(Array.from({ length: 80 }, (_, i) => ({ _id: "sto_" + i, stared: i < 60, title: String(i) })))
  const store = new PouchStoryStore(db, doc => doc)
  assert.equal((await store.getStaredStories()).length, 60)
  const first = await db.get("_local/once-starred-index-v1")
  const changed = await db.get("sto_0"), gone = await db.get("sto_1"), added = await db.get("sto_70")
  await db.bulkDocs([{ ...changed, stared: false }, { ...gone, _deleted: true }, { ...added, stared: true }])
  const rows = await store.getStaredStories()
  assert.equal(rows.length, 59)
  assert.ok(rows.some(doc => doc._id === "sto_70"))
  assert.ok(!rows.some(doc => doc._id === "sto_0" || doc._id === "sto_1"))
  const second = await db.get("_local/once-starred-index-v1")
  assert.notEqual(second.last_seq, first.last_seq)
  await store.getStaredStories()
  assert.equal((await db.get("_local/once-starred-index-v1"))._rev, second._rev, "unchanged queries do not write")
  assert.equal((await db.allDocs({ startkey: "_design/", endkey: "_design/\uffff" })).rows.length, 0, "no archive-wide Mango index is built")
})

test("concurrent starred readers converge via CAS and failed scans never advance the projection", async t => {
  const { open } = await fixture(t), db = open("starred-race")
  await db.put({ _id: "sto_a", stared: true })
  const one = new PouchStoryStore(db, doc => doc), two = new PouchStoryStore(db, doc => doc)
  const results = await Promise.all([one.getStaredStories(), two.getStaredStories()])
  assert.deepEqual(results.map(rows => rows.map(doc => doc._id)), [["sto_a"], ["sto_a"]])
  const before = await db.get("_local/once-starred-index-v1")
  await db.put({ _id: "sto_b", stared: true })
  const changes = db.changes.bind(db)
  db.changes = async () => { throw new Error("scan interrupted") }
  await assert.rejects(one.getStaredStories(), /scan interrupted/)
  assert.equal((await db.get("_local/once-starred-index-v1"))._rev, before._rev)
  db.changes = changes
  assert.equal((await one.getStaredStories()).length, 2)
})

test("a starred read requested after an edit does not reuse an older in-flight snapshot", async t => {
  const { open } = await fixture(t), db = open("starred-snapshot")
  await db.put({ _id: "sto_a", stared: true })
  const store = new PouchStoryStore(db, doc => doc), allDocs = db.allDocs.bind(db)
  let release, started
  const waiting = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let first = true
  db.allDocs = async options => {
    const rows = await allDocs(options)
    if (first) { first = false; started(); await gate }
    return rows
  }
  const initial = store.getStaredStories()
  await waiting
  await db.put({ ...await db.get("sto_a"), stared: false })
  const subsequent = store.getStaredStories()
  release()
  assert.equal((await initial).length, 1)
  assert.equal((await subsequent).length, 0)
})
