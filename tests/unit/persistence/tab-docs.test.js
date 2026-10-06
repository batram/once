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
