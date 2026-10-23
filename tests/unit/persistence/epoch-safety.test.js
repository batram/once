const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const { Story } = require("../../../packages/core/dist")
const { copyWinningRevisions, verifyWinningRevisions, censusRevisions, LocalDatabaseEpoch, PouchStoryStore, PouchSyncService, PouchMaintenanceService, LOCAL_POUCH_OPTIONS } = require("../../../packages/persistence/dist")
const { resolveSyncEpoch } = require("../../../packages/persistence/dist/SyncEpoch")
const { epochContent } = require("../../../packages/persistence/dist/EpochContent")

test("epoch content compares decoded bytes across compressed server and local digests", async () => {
  const attachment = { content_type: "text/html", data: Buffer.from("<p>same bytes</p>").toString("base64") }
  const server = { _id: "sto_a", _rev: "2-same", _attachments: { content: { ...attachment, digest: "md5-compressed", encoding: "gzip", encoded_length: 12 } } }
  const local = { _id: "sto_a", _rev: "2-same", _attachments: { content: { ...attachment, digest: "md5-decoded" } } }
  assert.equal(await epochContent(server), await epochContent(local))
  local._attachments.content.data = Buffer.from("<p>different bytes</p>").toString("base64")
  assert.notEqual(await epochContent(server), await epochContent(local))
})

async function world(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "once-epoch-safety-"))
  const handles = []
  const open = name => { const db = new PouchDB(name, LOCAL_POUCH_OPTIONS); handles.push(db); return db }
  const named = name => open(path.join(dir, name))
  const values = new Map()
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  t.after(async () => {
    await Promise.allSettled(handles.map(db => db.close()))
    // Only databases created by this fixture; close duplicate handles before destroying.
    for (const name of new Set(handles.map(db => db.name))) await new PouchDB(name).destroy()
    await fs.rmdir(dir)
  })
  return { open, named, storage, values }
}

test("a recreated active epoch with missing metadata cannot retire itself or enter a restart loop", async t => {
  const w = await world(t), original = w.named("device")
  const activeName = original.name + "@once_e2", active = w.open(activeName)
  const key = "once:local-database:" + original.name
  w.storage.setItem(key, JSON.stringify({ name: activeName, previous: original.name }))
  let opened = 0, restarted = 0
  const epoch = new LocalDatabaseEpoch(original.name, activeName, active, name => { opened++; return w.open(name) }, () => restarted++, w.storage)
  await assert.rejects(epoch.rebuild("https://example.test/once_e2"), /lost its epoch record/)
  assert.equal(opened, 0)
  assert.equal(restarted, 0)
  assert.equal((await active.info()).doc_count, 0)
  await assert.rejects(active.get("_local/once-sync-epoch"), { status: 404 })
  assert.equal(JSON.parse(w.storage.getItem(key)).name, activeName)
})

test("retired database recovery waits for the native pointer commit before restarting", async t => {
  const w = await world(t), db = w.named("native")
  await db.put({ _id: "_local/once-sync-epoch", retired: { database: db.name + "@next", destination: "https://example.test/once_e2" } })
  let commit, restarted = false
  const committed = new Promise(resolve => { commit = resolve })
  const storage = { getItem: () => null, setItem: () => committed }
  const epoch = new LocalDatabaseEpoch(db.name, db.name, db, w.open, () => { restarted = true }, storage)
  const resolving = resolveSyncEpoch("https://example.test/once", async () => { throw new Error("Must not contact server") }, epoch, () => {})
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(restarted, false)
  commit()
  assert.deepEqual(await resolving, { restarting: true })
  assert.equal(restarted, true)
})

test("a rejected native pointer commit cannot restart a retired database", async t => {
  const w = await world(t), db = w.named("native-failure")
  await db.put({ _id: "_local/once-sync-epoch", retired: { database: db.name + "@next", destination: "https://example.test/once_e2" } })
  let restarted = false
  const storage = { getItem: () => null, setItem: async () => { throw new Error("Native commit failed") } }
  const epoch = new LocalDatabaseEpoch(db.name, db.name, db, w.open, () => { restarted = true }, storage)
  await assert.rejects(resolveSyncEpoch("https://example.test/once", async () => null, epoch, () => {}), /Native commit failed/)
  assert.equal(restarted, false)
})

test("epoch verification rejects matching revisions with different bytes, extra documents, and incomplete reads", async t => {
  const w = await world(t), a = w.named("a"), b = w.named("b")
  const doc = text => ({ _id: "sto_item", _rev: "1-aaaaaaaa", _revisions: { start: 1, ids: ["aaaaaaaa"] },
    _attachments: { content: { content_type: "text/plain", data: Buffer.from(text).toString("base64") } } })
  await a.bulkDocs([doc("phone")], { new_edits: false })
  await b.bulkDocs([doc("desktop")], { new_edits: false })
  const different = await verifyWinningRevisions(a, b)
  assert.equal(different.ok, false)
  assert.deepEqual(different.contentMismatched, ["sto_item"])
  await assert.rejects(copyWinningRevisions(a, b, "a"), /Copied epoch content differs/)
  assert.equal((await b.getAttachment("sto_item", "content")).toString(), "desktop", "a revision collision is not silently overwritten")
  const clean = w.named("clean")
  await copyWinningRevisions(a, clean, "a")
  await clean.put({ _id: "unexpected", value: 1 })
  assert.deepEqual((await verifyWinningRevisions(a, clean)).extra, ["unexpected"])
  assert.equal((await verifyWinningRevisions(a, clean)).ok, false)
  t.mock.method(b, "bulkGet", async () => ({ results: [] }))
  assert.equal((await verifyWinningRevisions(a, b)).ok, false)
})

test("epoch copy refuses unresolved settings conflicts and invalid thumbnail content hashes", async t => {
  const w = await world(t), source = w.named("source"), target = w.named("target")
  await source.bulkDocs(["aaaaaaaa", "bbbbbbbb"].map(hash => ({ _id: "filter_list", _rev: `1-${hash}`, list: [hash] })), { new_edits: false })
  await assert.rejects(copyWinningRevisions(source, target, "source"), /Resolve live conflicts/)
  assert.equal((await source.get("filter_list", { conflicts: true }))._conflicts.length, 1)
  const broken = w.named("broken")
  await broken.put({ _id: "tth_bad", type: "thumb", contentHash: "wrong", _attachments: { "thumb.jpg": { content_type: "image/jpeg", data: "YQ==" } } })
  await assert.rejects(copyWinningRevisions(broken, target, "broken"), /integrity check failed/)
})

test("canonical reconciliation drops a proven obsolete branch but preserves a pending descendant", async t => {
  const w = await world(t), previous = w.named("previous"), canonical = w.named("canonical"), local = w.named("local")
  await previous.bulkDocs([{ _id: "sto_old", _rev: "1-aaaaaaaa", value: "old" }, { _id: "sto_old", _rev: "1-zzzzzzzz", value: "canonical" }], { new_edits: false })
  await local.bulkDocs([{ _id: "sto_old", _rev: "1-aaaaaaaa", value: "old" }], { new_edits: false })
  await previous.remove("sto_old", "1-aaaaaaaa")
  await previous.put({ _id: "sto_edit", value: "shared" })
  await previous.replicate.to(local, { doc_ids: ["sto_edit"] })
  await local.put({ ...await local.get("sto_edit"), value: "offline edit" })
  await copyWinningRevisions(previous, canonical, "previous")
  const epoch = new LocalDatabaseEpoch(local.name, local.name, local, w.open, () => {}, w.storage)
  await epoch.rebuild("https://sync.test/next", () => {}, { canonical, previous })
  const moved = w.open(`${local.name}@next`)
  assert.equal((await moved.get("sto_old")).value, "canonical")
  assert.equal((await moved.get("sto_edit")).value, "offline edit")
  await moved.replicate.to(canonical)
  assert.equal((await censusRevisions(canonical)).extraLeaves, 0)
})

test("unrelated pending edits stop migration without replacing or deleting local data", async t => {
  const w = await world(t), previous = w.named("previous"), canonical = w.named("canonical"), local = w.named("local")
  await previous.put({ _id: "sto_item", value: "remote" })
  await local.put({ _id: "sto_item", value: "pending" })
  await copyWinningRevisions(previous, canonical, "previous")
  const epoch = new LocalDatabaseEpoch(local.name, local.name, local, w.open, () => {}, w.storage)
  await assert.rejects(epoch.rebuild("https://sync.test/next", () => {}, { canonical, previous }), /ancestry cannot be reconciled/)
  assert.equal((await local.get("sto_item")).value, "pending")
  assert.equal((await epoch.state()).retired, undefined)
})

test("forked thumbnail slots take the canonical copy while a local descendant still moves", async t => {
  const w = await world(t), previous = w.named("previous"), canonical = w.named("canonical"), local = w.named("local")
  const thumb = (id, text) => ({ _id: id, type: "thumb", deviceId: "other", createdAt: text,
    contentHash: require("node:crypto").createHash("sha1").update(text).digest("hex"),
    _attachments: { "thumb.jpg": { content_type: "image/jpeg", data: Buffer.from(text).toString("base64") } } })
  await previous.put(thumb("tth_other_slot_000", "remote"))
  await local.put(thumb("tth_other_slot_000", "stale"))
  await previous.put(thumb("tth_other_slot_001", "shared"))
  await previous.replicate.to(local, { doc_ids: ["tth_other_slot_001"] })
  await local.put({ ...thumb("tth_other_slot_001", "newer"), _rev: (await local.get("tth_other_slot_001"))._rev })
  await copyWinningRevisions(previous, canonical, "previous")
  const epoch = new LocalDatabaseEpoch(local.name, local.name, local, w.open, () => {}, w.storage)
  await epoch.rebuild("https://sync.test/next", () => {}, { canonical, previous })
  const moved = w.open(`${local.name}@next`)
  assert.equal((await moved.get("tth_other_slot_000", { conflicts: true }))._conflicts, undefined)
  assert.equal((await moved.get("tth_other_slot_000")).createdAt, "remote")
  assert.equal((await moved.get("tth_other_slot_001")).createdAt, "newer")
  assert.equal((await local.get("tth_other_slot_000")).createdAt, "stale")
})

test("upgrading an earlier committed epoch reconciles into a new versioned local database", async t => {
  const w = await world(t), previous = w.named("previous"), canonical = w.named("canonical"), base = w.named("base").name
  const legacy = w.open(`${base}@next`)
  await previous.bulkDocs([{ _id: "sto_item", _rev: "1-aaaaaaaa", value: "old" }, { _id: "sto_item", _rev: "1-zzzzzzzz", value: "canonical" }], { new_edits: false })
  await previous.remove("sto_item", "1-aaaaaaaa")
  await copyWinningRevisions(previous, canonical, "previous")
  await legacy.bulkDocs([{ _id: "sto_item", _rev: "1-aaaaaaaa", value: "old" }], { new_edits: false })
  await legacy.put({ _id: "_local/once-sync-epoch", destination: "https://sync.test/next" })
  w.storage.setItem(`once:local-database:${base}`, JSON.stringify({ name: legacy.name }))
  const epoch = new LocalDatabaseEpoch(base, legacy.name, legacy, w.open, () => {}, w.storage)
  await resolveSyncEpoch("https://sync.test/old", async () => null, epoch, () => {}, async url => url.endsWith("/next/") ? canonical : previous)
  const migrated = w.open(`${base}@next@v4`)
  assert.equal((await migrated.get("sto_item")).value, "canonical")
  assert.equal((await migrated.get("_local/once-sync-epoch")).version, 4)
  assert.ok((await epoch.state()).retired)
  assert.equal((await censusRevisions(migrated)).extraLeaves, 0)
})

test("cancelling a migration leaves the old database writable and does not commit a pointer", async t => {
  const w = await world(t), local = w.named("local"), canonical = w.named("canonical"), previous = w.named("previous")
  await canonical.put({ _id: "sto_remote", value: "remote" })
  let current = true
  const epoch = new LocalDatabaseEpoch(local.name, local.name, local, w.open, () => {}, w.storage)
  await assert.rejects(epoch.rebuild("https://sync.test/next", () => { current = false }, { canonical, previous, isCurrent: () => current }), /session changed/)
  assert.equal(w.values.has(`once:local-database:${local.name}`), false)
  assert.equal((await epoch.state()).retired, undefined)
  await local.put({ _id: "sto_pending", value: "still writable" })
})

test("storage inspection and cancellation cannot contact the original database while resolving local state", async t => {
  const w = await world(t), local = w.named("local")
  let release, contacted = 0
  const waiting = new Promise(resolve => { release = resolve })
  const remote = { info: async () => { contacted++; return {} }, get: async () => { contacted++; throw { status: 404 } } }
  const service = new PouchSyncService(local, () => {}, () => remote, undefined, { state: () => waiting })
  service.syncFrom("https://sync.test/old")
  assert.equal(await service.storageInfo(), null)
  service.syncFrom("")
  release({ destination: "https://sync.test/next", version: 4 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(contacted, 0)
})

test("a concurrent writer waits for migration and is rejected on the retired source", async t => {
  const w = await world(t), source = w.named("source")
  await source.put({ _id: "sto_item", stared: false })
  const peer = w.open(source.name)
  new LocalDatabaseEpoch(source.name, source.name, peer, w.open, () => {}, w.storage)
  let late, target
  const open = name => {
    target = w.open(name)
    const put = target.put.bind(target)
    target.put = async doc => {
      if (doc._id === PouchMaintenanceService.COMPACTION_MARKER_ID) {
        late = peer.put({ ...await peer.get("sto_item"), stared: true })
        late.catch(() => {})
      }
      return put(doc)
    }
    return target
  }
  const epoch = new LocalDatabaseEpoch(source.name, source.name, source, open, () => {}, w.storage)
  await epoch.rebuild("https://sync.test/next")
  await assert.rejects(late, /retired/)
  assert.equal((await target.get("sto_item")).stared, false)
  await assert.rejects(peer.bulkDocs([{ _id: "late_replication" }], { new_edits: false }), /retired/)
})

test("committed targets survive pointer loss and retired databases retain durable routing", async t => {
  const w = await world(t), source = w.named("source")
  await source.put({ _id: "sto_item", stared: false })
  const epoch = new LocalDatabaseEpoch(source.name, source.name, source, w.open, () => {}, w.storage)
  await epoch.rebuild("https://sync.test/next")
  const active = w.open(`${source.name}@next`)
  const moved = new LocalDatabaseEpoch(source.name, active.name, active, w.open, () => {}, w.storage)
  await active.put({ ...await active.get("sto_item"), stared: true })
  await Promise.all([moved.recordSynchronized(), moved.recordSynchronized()])
  w.values.clear()
  let restarts = 0
  const recovery = new LocalDatabaseEpoch(source.name, source.name, source, w.open, () => { restarts++ }, w.storage)
  await resolveSyncEpoch("https://sync.test/old", async () => { throw Error("must not contact a remote") }, recovery, () => {})
  assert.equal(restarts, 1)
  assert.equal((await active.get("sto_item")).stared, true)
  assert.ok((await epoch.state()).retired)
  // Even an externally recreated base cannot turn the committed target into a disposable copy.
  const other = w.named("other")
  await other.put({ _id: "sto_item", stared: false })
  w.values.clear()
  const unsafe = new LocalDatabaseEpoch(source.name, source.name, other, w.open, () => {}, w.storage)
  await assert.rejects(unsafe.rebuild("https://sync.test/next"), /already committed/)
  assert.equal((await active.get("sto_item")).stared, true)
})

test("an occupied unrecognized target cannot be destroyed as a staging copy", async t => {
  const w = await world(t), source = w.named("source"), target = w.open(`${source.name}@next`)
  await source.put({ _id: "sto_item", value: "source" })
  await target.put({ _id: "sto_item", value: "unrelated data" })
  const epoch = new LocalDatabaseEpoch(source.name, source.name, source, w.open, () => {}, w.storage)
  await assert.rejects(epoch.rebuild("https://sync.test/next"), /not a recognized staging copy/)
  assert.equal((await target.get("sto_item")).value, "unrelated data")
})

test("atomic content writes retain old bytes and metadata on failure, then retry together", async t => {
  const w = await world(t), db = w.named("content"), store = new PouchStoryStore(db, Story.from_obj.bind(Story))
  const story = new Story("RSS", "https://example.test/item", "Item", "", 1000)
  story.attachContent("<p>Old</p>", { source: "feed", saved_at: 1000 })
  await store.saveStory(story)
  const before = await db.get(story._id)
  const put = db.put.bind(db)
  let fail = true
  t.mock.method(db, "put", async doc => { if (fail) { fail = false; throw Object.assign(new Error("synthetic write failure"), { status: 500 }) } return put(doc) })
  story.attachContent("<p>New</p>", { source: "feed", saved_at: 1000 })
  await assert.rejects(store.saveStory(story), /synthetic write failure/)
  assert.deepEqual((await db.get(story._id)).stored_content, before.stored_content)
  assert.equal(await store.getStoryContent(story.href), "<p>Old</p>")
  await store.saveStory(story)
  assert.equal(await store.getStoryContent(story.href), "<p>New</p>")
  assert.equal(Number(story._rev.split("-")[0]), 2, "one revision per complete content update")
  // A historical two-step write may already have left truthful-looking metadata over wrong bytes.
  await db.putAttachment(story._id, "content", story._rev, Buffer.from("<p>Old</p>"), "text/html")
  story.attachContent("<p>New</p>", { source: "feed", saved_at: 1000 })
  await store.saveStory(story)
  assert.equal(await store.getStoryContent(story.href), "<p>New</p>", "deduplication validates bytes, not metadata alone")
})

test("the restored default ancestry relates more than 100 unpublished updates", async t => {
  const w = await world(t), publisher = w.named("publisher"), server = w.named("server")
  let result = await publisher.put({ _id: "dev_test", seq: 1 })
  await publisher.replicate.to(server)
  for (let seq = 2; seq <= 102; seq++) result = await publisher.put({ _id: "dev_test", _rev: result.rev, seq })
  await publisher.replicate.to(server)
  assert.equal((await censusRevisions(server)).extraLeaves, 0)
})

test("a stale read-state edit preserves the metadata belonging to the newer attachment", async t => {
  const w = await world(t), db = w.named("content"), store = new PouchStoryStore(db, Story.from_obj.bind(Story))
  const story = new Story("RSS", "https://example.test/item", "Item", "", 1000)
  story.attachContent("<p>Old</p>", { source: "feed", saved_at: 1000 })
  await store.saveStory(story)
  const stale = Story.from_obj(story.to_obj())
  story.attachContent("<p>Updated article</p>", { source: "page", saved_at: 2000 })
  await store.saveStory(story)
  const metadata = structuredClone(story.stored_content)
  stale.read_state = "read"
  await store.saveStory(stale)
  assert.deepEqual((await db.get(story._id)).stored_content, metadata)
  assert.equal(await store.getStoryContent(story.href), "<p>Updated article</p>")
  await copyWinningRevisions(db, w.named("verified-copy"), "content")
})
