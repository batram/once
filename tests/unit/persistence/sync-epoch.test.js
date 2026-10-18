const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const { installFence, FENCE_ID } = require("../../../scripts/couch-epoch-fence")
const { syncDatabaseName } = require("../../../packages/core/dist")
const {
  activeLocalDatabaseName,
  censusRevisions,
  copyWinningRevisions,
  followSyncEpoch,
  LocalDatabaseEpoch,
  PouchSyncService,
  SyncEpochPendingError
} = require("../../../packages/persistence/dist")

const URL_ = "https://user:secret@couch.test/once/"

async function until(check, what) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/**
 * A server with `once` and an empty `once_e2`, and a device whose local
 * database starts the way a platform opens it. `start()` is one app start:
 * it opens the active local database and connects, like a reload would.
 */
async function world(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "once-sync-epoch-"))
  const opened = []
  const open = name => { const db = new PouchDB(name); opened.push(db); return db }
  const server = { once: open(path.join(dir, "server-once")), once_e2: open(path.join(dir, "server-once_e2")) }
  const storage = new Map()
  const pointer = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  const base = path.join(dir, "phone")
  const devices = []
  const start = () => {
    const name = activeLocalDatabaseName(base, pointer)
    const db = open(name)
    const device = { db, name, statuses: [], restarts: 0 }
    device.epoch = new LocalDatabaseEpoch(base, name, db, open, () => { device.restarts++ }, pointer)
    device.service = new PouchSyncService(db, () => {}, url => server[syncDatabaseName(url)], undefined, device.epoch)
    device.service.onStatus(status => device.statuses.push(status))
    device.status = () => device.statuses.at(-1)
    devices.push(device)
    return device
  }
  t.after(async () => {
    devices.forEach(device => device.service.syncFrom(""))
    await Promise.all(opened.map(db => db.close().catch(() => undefined)))
    await fs.rm(dir, { recursive: true, force: true })
  })
  return { server, start, storage, pointer, base, open }
}

/** What an operator's freeze, copy and open do (scripts/couch-epoch.js). */
async function moveServer(server, { open = true } = {}) {
  const compat = await server.once.get("once_sync_compat")
  await server.once.put({ ...compat, minSyncProtocol: 4 })
  await server.once.put({ _id: "once_sync_epoch", schema: 1, state: "preparing", next: "once_e2" })
  await installFence(server.once)
  if (!open) return
  await copyWinningRevisions(server.once, server.once_e2, "once", { exclude: id => id === "once_sync_epoch" || id === FENCE_ID })
  const marker = await server.once.get("once_sync_epoch")
  await server.once.put({ ...marker, state: "ready" })
}

/** The bloat a real server collects: a story two devices created, its losing branch deleted. */
async function seedConflict(server, dir) {
  const a = new PouchDB(path.join(dir, "seed-a")), b = new PouchDB(path.join(dir, "seed-b"))
  await a.put({ _id: "sto_a", title: "A", device: "a" })
  await b.put({ _id: "sto_a", title: "A", device: "b" })
  await a.replicate.to(server.once)
  await b.replicate.to(server.once)
  const winner = await server.once.get("sto_a", { conflicts: true })
  await server.once.bulkDocs(winner._conflicts.map(rev => ({ _id: "sto_a", _rev: rev, _deleted: true })))
  await Promise.all([a.close(), b.close()])
}

test("a device follows a ready epoch: rebuilds, restarts, and syncs only winners to the new database", async t => {
  const w = await world(t)
  await seedConflict(w.server, path.dirname(w.base))
  const first = w.start()
  first.service.syncFrom(URL_)
  await until(() => first.status()?.state === "up-to-date", "the first sync")
  assert.equal((await censusRevisions(first.db)).extraLeaves, 1, "the device holds the losing branch too")

  // Offline edit, then the operator moves the server.
  first.service.syncFrom("")
  const story = await first.db.get("sto_a")
  await first.db.put({ ...story, read_state: "read" })
  await moveServer(w.server)

  first.service.syncFrom(URL_)
  await until(() => first.restarts === 1, "the restart after the rebuild")
  assert.match(first.status().message, /Restarting on the cleaned-up local database/)
  assert.equal(activeLocalDatabaseName(w.base, w.pointer), `${w.base}@once_e2`)
  assert.equal((await w.server.once.get("sto_a")).read_state, undefined, "the pending edit never reached the old database")

  const second = w.start()
  second.service.syncFrom(URL_)
  await until(() => second.status()?.state === "up-to-date", "the sync on the new epoch")
  await until(async () => (await w.server.once_e2.get("sto_a")).read_state === "read", "the pending edit on the new database")
  const merged = await w.server.once_e2.get("sto_a", { conflicts: true, deleted_conflicts: true })
  assert.equal(merged._conflicts, undefined)
  assert.equal(merged._deleted_conflicts, undefined)
  assert.equal((await censusRevisions(w.server.once_e2)).extraLeaves, 0)
  assert.equal((await censusRevisions(second.db)).extraLeaves, 0)
  await assert.rejects(second.db.get("once_sync_epoch"), { status: 404 }, "the marker never replicates")
  await assert.rejects(second.db.get(FENCE_ID), { status: 404 }, "the source fence never replicates")
  await assert.rejects(w.server.once_e2.get(FENCE_ID), { status: 404 }, "the operator copy leaves the source fence behind")
  await until(async () => Boolean((await second.epoch.state()).synchronized_at), "the new epoch sync to be acknowledged")
  assert.equal(JSON.parse(w.storage.get(`once:local-database:${w.base}`)).previous, w.base, "retain the backup and durable routing marker")
  assert.equal((await first.epoch.state()).retired.database, second.name)
  assert.equal(second.restarts, 0)
})

test("while a move is prepared the device pauses, keeps its edits, and retries", async t => {
  const w = await world(t)
  const device = w.start()
  device.service.syncFrom(URL_)
  await until(() => device.status()?.state === "up-to-date", "the first sync")
  await moveServer(w.server, { open: false })
  await until(() => device.status()?.state === "retrying", "the live sync to stop")
  assert.match(device.status().message, /cleaned up/)
  await device.db.put({ _id: "sto_later", title: "Later" })
  await new Promise(resolve => setTimeout(resolve, 200))
  await assert.rejects(w.server.once.get("sto_later"), { status: 404 }, "nothing reaches the database being copied")
  assert.equal(device.restarts, 0)
})

test("a lost pointer reopens the retired database, which restores the switch instead of syncing", async t => {
  const w = await world(t)
  const first = w.start()
  first.service.syncFrom(URL_)
  await until(() => first.status()?.state === "up-to-date", "the first sync")
  first.service.syncFrom("")
  await moveServer(w.server)
  first.service.syncFrom(URL_)
  await until(() => first.restarts === 1, "the rebuild")

  w.storage.clear()
  const reopened = w.start()
  assert.equal(reopened.name, w.base, "without the pointer the original database opens")
  reopened.service.syncFrom(URL_)
  await until(() => reopened.restarts === 1, "the pointer to be restored")
  assert.equal(activeLocalDatabaseName(w.base, w.pointer), `${w.base}@once_e2`)
  assert.notEqual(reopened.status().state, "up-to-date")
})

test("a moved device never contacts the old database again, so it may be deleted", async t => {
  const w = await world(t)
  const first = w.start()
  first.service.syncFrom(URL_)
  await until(() => first.status()?.state === "up-to-date", "the first sync")
  first.service.syncFrom("")
  await moveServer(w.server)
  first.service.syncFrom(URL_)
  await until(() => first.restarts === 1, "the rebuild")

  // Retired by an administrator: any request would be a 404, or would try
  // to create the database again through PouchDB's setup request.
  const old = w.server.once
  const contacted = []
  w.server.once = new Proxy({}, { get: (_, name) => (...args) => {
    contacted.push(String(name))
    return Promise.reject(Object.assign(new Error("Database does not exist."), { status: 404, reason: "Database does not exist." }))
  } })
  t.after(() => { w.server.once = old })
  const moved = w.start()
  moved.service.syncFrom(URL_)
  await until(() => moved.status()?.state === "up-to-date", "the sync on the new database")
  assert.deepEqual(contacted, [], "the deleted database is never contacted")
  await moved.db.put({ _id: "sto_after", title: "After" })
  await until(async () => Boolean(await w.server.once_e2.get("sto_after").catch(() => null)), "the edit on the new database")
})

test("a client without an epoch mover refuses a ready epoch", async t => {
  const w = await world(t)
  const plain = w.open(path.join(path.dirname(w.base), "plain"))
  const unsupported = new PouchSyncService(plain, () => {}, url => w.server[syncDatabaseName(url)])
  const statuses = []
  unsupported.onStatus(status => statuses.push(status))
  const marker = { _id: "once_sync_epoch", schema: 1, state: "ready", next: "once_e2" }
  await w.server.once.put(marker)
  unsupported.syncFrom(URL_)
  await until(() => statuses.at(-1)?.state === "error", "the refusal without an epoch mover")
  unsupported.syncFrom("")
})

test("a fresh installation discovers the canonical database through the retained original marker", async t => {
  const w = await world(t)
  const device = w.start()
  device.service.syncFrom(URL_)
  await until(() => device.status()?.state === "up-to-date", "initial sync")
  device.service.syncFrom("")
  await w.server.once.put({ _id: "sto_discover", title: "Retained" })
  await moveServer(w.server)
  const base = path.join(path.dirname(w.base), "fresh")
  const db = w.open(base)
  let restarted = false
  const epoch = new LocalDatabaseEpoch(base, base, db, w.open, () => { restarted = true }, w.pointer)
  const service = new PouchSyncService(db, () => {}, url => w.server[syncDatabaseName(url)], undefined, epoch)
  t.after(() => service.syncFrom(""))
  service.syncFrom(URL_)
  await until(() => restarted, "fresh installation migration")
  assert.equal((await w.open(`${base}@once_e2`).get("sto_discover")).title, "Retained")
})

test("an unsupported canonical protocol stops before local migration", async t => {
  const w = await world(t), device = w.start()
  device.service.syncFrom(URL_)
  await until(() => device.status()?.state === "up-to-date", "initial sync")
  device.service.syncFrom("")
  await moveServer(w.server)
  await w.server.once_e2.put({ ...await w.server.once_e2.get("once_sync_compat"), minSyncProtocol: 5 })
  device.service.syncFrom(URL_)
  await until(() => device.status()?.state === "update-required", "compatibility refusal before copying")
  assert.equal(device.restarts, 0)
  assert.equal((await device.epoch.state()).retired, undefined)
  assert.equal(activeLocalDatabaseName(w.base, w.pointer), w.base)
})

test("epoch markers lead only to sibling databases, and never in a loop", async () => {
  const markers = new Map()
  const read = async url => markers.get(syncDatabaseName(url)) ?? null
  assert.equal(await followSyncEpoch(URL_, read), URL_)
  markers.set("once", { schema: 1, state: "ready", next: "once_e2" })
  assert.equal(await followSyncEpoch(URL_, read), "https://user:secret@couch.test/once_e2/", "credentials carry over")
  markers.set("once_e2", { schema: 1, state: "preparing", next: "once_e3" })
  await assert.rejects(followSyncEpoch(URL_, read), SyncEpochPendingError)
  markers.set("once_e2", { schema: 1, state: "ready", next: "once" })
  markers.set("once", { schema: 1, state: "ready", next: "once_e2" })
  await assert.rejects(followSyncEpoch(URL_, read), /too many times/)
  for (const next of ["https://evil.test/once", "../once", "Once", "once/e2"]) {
    markers.set("once", { schema: 1, state: "ready", next })
    await assert.rejects(followSyncEpoch(URL_, read), /damaged/, next)
  }
})
