const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const { pouchTabDocs } = require("../../../packages/persistence/dist")
const { TabDocRepository } = require("../../../packages/app/dist/tabsync/TabDocRepository")
const { deviceDocument } = require("../../../packages/app/dist/tabsync/tabPublication")

const id = "0123456789abcdef0123456789abcdef"
const identity = (seq, epoch = 1) => ({ deviceId: id, epoch, seq, name: "Laptop", platform: "electron", appVersion: "1" })
const windows = (url) => [{ id: "w", focused: true, tabs: [{ id: "t", navSeq: 1, url, title: url, mode: "web", active: true,
  openedAt: "2026-10-06T10:00:00.000Z", navigatedAt: "2026-10-06T10:00:00.000Z", selectedAt: "2026-10-06T10:00:00.000Z",
  activityAt: "2026-10-06T10:00:00.000Z" }] }]

async function databases(names) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-tab-docs-"))
  // The apps' own revision limit, which is what makes long offline runs conflict.
  const dbs = names.map((name) => new PouchDB(path.join(directory, name), { revs_limit: 20 }))
  return { dbs, close: async () => { await Promise.all(dbs.map((db) => db.close())); await fs.rm(directory, { recursive: true, force: true }) } }
}

test("more than twenty offline publications reconcile to the highest sequence with no conflicts left", async () => {
  const { dbs: [laptop, server, phone], close } = await databases(["laptop", "server", "phone"])
  try {
    const repo = new TabDocRepository(pouchTabDocs(laptop))
    await repo.publish(deviceDocument(identity(1), windows("https://example.com/1"), true))
    await laptop.replicate.to(server)
    await phone.replicate.from(server)
    // A copy of the same publication edited on the phone side (as a copied
    // profile or a stale branch would), while the laptop keeps publishing offline.
    const branch = new TabDocRepository(pouchTabDocs(phone))
    await branch.publish(deviceDocument(identity(2), windows("https://example.com/branch"), true))
    for (let seq = 2; seq <= 30; seq++) await repo.publish(deviceDocument(identity(seq), windows(`https://example.com/${seq}`), true))
    await phone.replicate.to(server)
    await laptop.replicate.from(server)
    const raw = await laptop.get(`dev_${id}`, { conflicts: true })
    assert.ok(raw._conflicts?.length, "replication left a conflict to resolve")
    const winner = await repo.resolveDevice(id)
    assert.equal(winner.seq, 30)
    assert.equal(winner.windows[0].tabs[0].url, "https://example.com/30")
    assert.equal((await laptop.get(`dev_${id}`, { conflicts: true }))._conflicts, undefined)
    await laptop.replicate.to(server)
    await phone.replicate.from(server)
    const listed = await new TabDocRepository(pouchTabDocs(phone)).listDevices()
    assert.equal(listed[0].seq, 30)
    assert.equal((await phone.get(`dev_${id}`, { conflicts: true }))._conflicts, undefined)
  } finally {
    await close()
  }
})

test("a retirement keeps the highest epoch, and forgetting deletes the device's documents", async () => {
  const { dbs: [db], close } = await databases(["db"])
  try {
    const repo = new TabDocRepository(pouchTabDocs(db))
    await repo.publish(deviceDocument(identity(1, 3), windows("https://example.com/"), true))
    await db.put({ _id: `tth_${id}_abc`, type: "thumb" })
    await repo.retire({ deviceId: id, retiredEpoch: 3, retiredAt: "2026-10-06T10:00:00.000Z", retiredBy: "Phone" })
    await repo.retire({ deviceId: id, retiredEpoch: 2, retiredAt: "2026-10-06T11:00:00.000Z", retiredBy: "Tablet" })
    assert.equal((await repo.readRetirement(id)).retiredBy, "Phone")
    await repo.deleteDevice(id)
    await repo.deleteThumbs(id)
    assert.deepEqual(await repo.listDevices(), [])
    assert.deepEqual((await db.allDocs({ startkey: "tth_", endkey: "tth_￿" })).rows, [])
    assert.equal((await repo.listRetirements()).length, 1)
  } finally {
    await close()
  }
})

test("replication routes pulled tab records, deletions included, and pulls them before stories", async () => {
  const { PouchSyncService } = require("../../../packages/persistence/dist")
  const { dbs: [local, server], close } = await databases(["local", "server"])
  const service = new PouchSyncService(local, () => {}, () => server)
  try {
    const repo = new TabDocRepository(pouchTabDocs(server))
    await repo.publish(deviceDocument(identity(1), windows("https://example.com/"), true))
    await server.put({ _id: "sto_https://example.com/story", href: "https://example.com/story" })
    const tabChanges = []
    const storyChanges = []
    service.onRemoteTabChange((change) => tabChanges.push(change))
    service.onRemoteChange((change) => storyChanges.push(change.id))
    const upToDate = new Promise((resolve) => service.onStatus((status) => { if (status.state === "up-to-date") resolve() }))
    service.syncFrom("https://sync.example.test/once")
    await upToDate
    assert.deepEqual(tabChanges.map((change) => change.id), [`dev_${id}`])
    assert.deepEqual(storyChanges, ["sto_https://example.com/story"])
    await repo.deleteDevice(id)
    const deadline = Date.now() + 5000
    while (!tabChanges.some((change) => change.doc._deleted) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(tabChanges.some((change) => change.id === `dev_${id}` && change.doc._deleted), "the deletion was routed")
    assert.equal(await service.hasLocalData(), true)
  } finally {
    service.syncFrom("")
    await close()
  }
})

test("the HTTP store authenticates from the URL, pages within its prefix and stops when not allowed", async () => {
  const { couchHttpTabDocs } = require("../../../packages/persistence/dist")
  const expressPouchDB = require("express-pouchdb")
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-tab-http-"))
  const Db = PouchDB.defaults({ prefix: directory + path.sep })
  const remote = new Db("once")
  await remote.info()
  const api = expressPouchDB(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const server = await new Promise((resolve) => { const listening = api.listen(0, "127.0.0.1", () => resolve(listening)) })
  const authorizations = []
  const recordingFetch = (url, init) => { authorizations.push(init?.headers?.authorization ?? ""); return fetch(url, init) }
  let allowed = true
  try {
    const url = `http://user:p%40ss@127.0.0.1:${server.address().port}/once`
    const freshDocs = couchHttpTabDocs(url.replace(/once$/, "fresh"), recordingFetch, async () => allowed)
    assert.deepEqual(await freshDocs.page("tth_"), { docs: [] })
    const fresh = new TabDocRepository(freshDocs)
    const reference = await fresh.putThumb(id, Buffer.from("new database").toString("base64"), 320, 200)
    assert.ok(await fresh.thumbnail(reference), "the first screenshot can create the remote database")
    const docs = couchHttpTabDocs(url, recordingFetch, async () => allowed)
    const repo = new TabDocRepository(docs)
    await repo.publish(deviceDocument(identity(1), windows("https://example.com/"), true))
    await repo.publish(deviceDocument(identity(2), windows("https://example.com/2"), true))
    assert.equal((await remote.get(`dev_${id}`)).seq, 2)
    assert.equal(authorizations[0], `Basic ${Buffer.from("user:p@ss").toString("base64")}`)
    const target = "fedcba9876543210fedcba9876543210"
    const sends = Array.from({ length: 205 }, (_, index) => ({ _id: `tsend_${target}_${String(index).padStart(3, "0")}`, type: "send",
      from: id, fromName: "x", url: "https://example.com/", title: "x", mode: "web", createdAt: new Date().toISOString() }))
    await remote.bulkDocs([...sends, { _id: `tsend_${target}`, type: "send" }, { _id: `tsend_${target}0`, type: "send" }, { _id: "tsendz" }])
    const listed = await docs.list(`tsend_${target}_`)
    assert.equal(listed.length, 205, "pages past the first and stays within the prefix")
    assert.equal((await repo.listSends(target)).length, 205)
    allowed = false
    await assert.rejects(repo.publish(deviceDocument(identity(3), windows("https://example.com/3"), true)), /not allowed/)
    assert.equal((await remote.get(`dev_${id}`)).seq, 2)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await remote.destroy()
    // express-pouchdb installs pouchdb-all-dbs, whose registry database stays
    // open; on Windows its LevelDB log cannot be unlinked until it is closed.
    // allDbs() drains its queue first. resetAllDbs() would not do: with a prefix
    // the registry's own destroy event re-registers it. Closing any instance of
    // the same name closes the shared LevelDB store.
    await Db.allDbs()
    await new Db("pouch__all_dbs__").close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("screenshots use reusable slots, read back as data URLs, and respect collection grace", async () => {
  const { dbs: [db], close } = await databases(["db"])
  try {
    const repo = new TabDocRepository(pouchTabDocs(db))
    const jpeg = Buffer.from("not really a jpeg").toString("base64")
    const first = await repo.putThumb(id, jpeg, 320, 200)
    assert.equal(await repo.putThumb(id, jpeg, 320, 200), first, "the same picture is stored once")
    assert.match(first, new RegExp(`^tth_${id}_slot_[0-9]{3}#[0-9a-f]{40}$`))
    assert.equal(await repo.thumbnail(first), `data:image/jpeg;base64,${jpeg}`)
    assert.equal(await repo.thumbnail(`dev_${id}`), null)
    const old = await repo.putThumb(id, Buffer.from("older").toString("base64"), 320, 200)
    const stored = await db.get(old.split("#")[0])
    await db.put({ ...stored, createdAt: new Date(Date.now() - 2 * 3600_000).toISOString() })
    await repo.deleteThumbs(id, new Set(), Date.now() - 3600_000)
    const left = (await db.allDocs({ startkey: "tth_", endkey: "tth_￿" })).rows.map((row) => row.id)
    assert.deepEqual(left, [first.split("#")[0]], "only the unreferenced screenshot older than the grace period goes")
  } finally {
    await close()
  }
})


test("many distinct screenshots keep bounded IDs and old references never show a replacement image", async () => {
  const { dbs: [db], close } = await databases(["db"])
  try {
    const repo = new TabDocRepository(pouchTabDocs(db))
    const first = await repo.putThumb(id, Buffer.from("first").toString("base64"), 320, 200)
    for (let index = 0; index < 140; index++) await repo.putThumb(id, Buffer.from(`shot-${index}`).toString("base64"), 320, 200)
    const rows = (await db.allDocs({ startkey: "tth_", endkey: "tth_￿" })).rows
    assert.equal(rows.length, 128)
    assert.equal(await repo.thumbnail(first), null)
    const huge = Buffer.alloc(65537).toString("base64")
    assert.equal(await repo.putThumb(id, huge, 320, 200), null)
  } finally { await close() }
})

test("maintenance resumes bounded pages after deletion and worker restart, without publishing", async () => {
  const { TabSyncMaintenance } = require("../../../packages/app/dist/tabsync/TabSyncMaintenance")
  const { DeviceIdentity } = require("../../../packages/app/dist/tabsync/DeviceIdentity")
  const { dbs: [db], close } = await databases(["db"])
  const secrets = new Map()
  const identity = new DeviceIdentity({ get: async key => secrets.get(key) || "", set: async (key, value) => secrets.set(key, value) }, "chrome", "Test")
  const adapter = pouchTabDocs(db)
  let pages = 0
  const repo = new TabDocRepository({ ...adapter, page: (...args) => { pages++; return adapter.page(...args) } })
  const old = new Date(Date.now() - 20 * 86400_000).toISOString()
  try {
    await db.bulkDocs(Array.from({ length: 205 }, (_, index) => ({ _id: `tsend_${id}_${String(index).padStart(4, "0")}`,
      type: "send", from: id, fromName: "Test", url: "https://example.com/", title: "old", mode: "web", createdAt: old })))
    await db.bulkDocs(Array.from({ length: 205 }, (_, index) => ({ _id: `tth_${id}_legacy_${String(index).padStart(4, "0")}`,
      type: "thumb", deviceId: id, createdAt: old })))
    const make = () => new TabSyncMaintenance(repo, identity, async () => true, 3600_000)
    await make().run(14)
    assert.equal((await repo.listSends()).length, 105)
    assert.equal(JSON.parse(await identity.readMaintenance()).pending, true)
    await make().run(14)
    assert.equal((await repo.listSends()).length, 5)
    await make().run(14)
    assert.equal((await repo.listSends()).length, 0)
    assert.equal((await adapter.list("tth_")).length, 0)
    assert.equal(JSON.parse(await identity.readMaintenance()).pending, false)
    const before = pages
    await make().run(14)
    assert.equal(pages, before, "completed maintenance is throttled across worker restarts")
    assert.ok((await make().storage()).lastCompletedAt)
  } finally { await close() }
})

test("reused screenshot conflicts discard losing attachment leaves deterministically", async () => {
  const { dbs: [db], close } = await databases(["db"])
  try {
    const repo = new TabDocRepository(pouchTabDocs(db))
    const first = await repo.putThumb(id, Buffer.from("first").toString("base64"), 320, 200)
    const slot = first.split("#")[0]
    const hash = "f".repeat(40)
    await db.bulkDocs([{ _id: slot, _rev: "2-aaaa", _revisions: { start: 2, ids: ["aaaa", "bbbb"] },
      type: "thumb", deviceId: id, contentHash: hash, createdAt: "2099-01-01T00:00:00.000Z",
      _attachments: { "thumb.jpg": { content_type: "image/jpeg", data: Buffer.from("newest").toString("base64") } }
    }], { new_edits: false })
    assert.ok((await db.get(slot, { conflicts: true }))._conflicts.length)
    assert.equal(await repo.thumbnail(`${slot}#${hash}`), `data:image/jpeg;base64,${Buffer.from("newest").toString("base64")}`)
    assert.equal((await db.get(slot, { conflicts: true }))._conflicts, undefined)
    assert.equal(await repo.thumbnail(first), null)
  } finally { await close() }
})
