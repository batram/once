const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const PouchDB = require("pouchdb")
const { LocalDatabaseEpoch } = require("../../../packages/persistence/dist")
const { reviewEpochSetting, resolveEpochSetting, EpochSettingReviewError } = require("../../../packages/persistence/dist/EpochSettingReview")

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-setting-review-"))
  const handles = [], backups = []
  const open = name => { const db = new PouchDB(name); handles.push(db); return db }
  const local = open(path.join(directory, "device")), remote = open(path.join(directory, "canonical")), previous = open(path.join(directory, "old"))
  const branch = (rev, ancestors, value) => ({ _id: "swipe", _rev: rev, _revisions: { start: Number(rev.split("-")[0]), ids: ancestors }, list: { twoStage: value } })
  await local.bulkDocs([branch("2-a", ["a", "root"], false), branch("2-b", ["b", "root"], true)], { new_edits: false })
  await remote.bulkDocs([branch("3-c", ["c", "a", "root"], false)], { new_edits: false })
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  const write = local.bulkDocs.bind(local)
  local.bulkDocs = (...args) => {
    for (const doc of Array.isArray(args[0]) ? args[0] : args[0].docs) if (doc._id?.startsWith("_local/once-setting-review-")) backups.push(doc._id)
    return write(...args)
  }
  const epoch = new LocalDatabaseEpoch(local.name, local.name, local, open, () => {}, storage)
  t.after(async () => {
    await Promise.allSettled(handles.map(db => db.close()))
    for (const name of new Set(handles.map(db => db.name))) await new PouchDB(name).destroy()
    await fs.rmdir(directory)
  })
  const migrate = () => epoch.rebuild("https://example.test/once_e2", () => {}, { canonical: remote, previous })
  return { local, remote, previous, epoch, migrate, backups, storage, open, branch }
}

for (const choice of ["remote", "2-b"]) test(`reviewed ${choice} setting resolves local conflict and completes migration without modifying server`, { timeout: 10000 }, async t => {
  const f = await fixture(t), before = await f.remote.info()
  await assert.rejects(f.migrate(), EpochSettingReviewError)
  const review = await f.epoch.reviewSetting("swipe")
  assert.equal(review.choices.length, 2)
  assert.equal(review.choices[0].label, "Synced version")
  assert.deepEqual(review.localRevisions, ["2-a", "2-b"])
  await f.epoch.resolveSetting({ ...review, choice })
  const resolved = await f.local.get("swipe", { conflicts: true })
  assert.equal(resolved.list.twoStage, choice !== "remote")
  assert.equal(resolved._conflicts, undefined)
  if (choice === "remote") assert.equal(resolved._rev, "3-c", "choosing canonical bytes need not create a new remote revision")
  assert.equal(f.backups.length, 1)
  const backup = await f.local.get(f.backups[0])
  assert.deepEqual(backup.local.map(doc => doc._rev).sort(), ["2-a", "2-b"])
  assert.equal(backup.remote._rev, "3-c")
  assert.equal((await f.remote.info()).update_seq, before.update_seq)
  await f.migrate()
  const pointer = JSON.parse(f.storage.getItem("once:local-database:" + f.local.name))
  assert.ok(pointer.name.endsWith("@once_e2"))
  const moved = await f.open(pointer.name).get("swipe", { conflicts: true })
  assert.equal(moved.list.twoStage, choice !== "remote")
  assert.equal(moved._conflicts, undefined)
})

test("stale local or remote versions are rejected before any backup or resolution write", async t => {
  const f = await fixture(t)
  const review = await reviewEpochSetting(f.local, f.remote, "swipe")
  await f.remote.put({ ...await f.remote.get("swipe"), list: { twoStage: true } })
  await assert.rejects(resolveEpochSetting(f.local, f.remote, { ...review, choice: "remote" }), /changed while/)
  assert.equal(f.backups.length, 0)
  const fresh = await reviewEpochSetting(f.local, f.remote, "swipe")
  await f.local.put({ ...await f.local.get("swipe"), list: { twoStage: false } })
  await assert.rejects(resolveEpochSetting(f.local, f.remote, { ...fresh, choice: "remote" }), /changed while/)
  assert.equal(f.backups.length, 0)
})

test("vaults and unknown documents never expose versions through the settings resolver", async t => {
  const f = await fixture(t)
  await assert.rejects(reviewEpochSetting(f.local, f.remote, "addon_vault"), /own recovery controls/)
  await assert.rejects(reviewEpochSetting(f.local, f.remote, "constructor"), /own recovery controls/)
  assert.equal(f.backups.length, 0)
})

test("cancelled sessions and failed backup writes preserve every original branch", async t => {
  const f = await fixture(t), review = await reviewEpochSetting(f.local, f.remote, "swipe")
  await assert.rejects(resolveEpochSetting(f.local, f.remote, { ...review, choice: "remote" }, () => false), /session changed/)
  const before = (await f.local.info()).update_seq
  const put = f.local.put.bind(f.local)
  f.local.put = doc => doc._id.startsWith("_local/once-setting-review-") ? Promise.reject(new Error("Backup failed")) : put(doc)
  await assert.rejects(resolveEpochSetting(f.local, f.remote, { ...review, choice: "remote" }), /Backup failed/)
  assert.equal((await f.local.info()).update_seq, before)
  assert.equal((await f.local.get("swipe", { conflicts: true }))._conflicts.length, 1)
})

test("identical settings branches migrate automatically using the canonical revision and retaining originals", async t => {
  const f = await fixture(t)
  await f.local.put({ ...await f.local.get("swipe"), list: { twoStage: false } })
  const before = await f.local.info(), remoteBefore = await f.remote.info()
  const review = await reviewEpochSetting(f.local, f.remote, "swipe")
  assert.equal(review.choices.length, 1)
  assert.equal(review.choices[0].key, "remote")
  await f.migrate()
  const pointer = JSON.parse(f.storage.getItem("once:local-database:" + f.local.name))
  const moved = await f.open(pointer.name).get("swipe", { conflicts: true })
  assert.equal(moved._rev, "3-c")
  assert.equal(moved._conflicts, undefined)
  assert.equal((await f.local.info()).update_seq, before.update_seq)
  assert.equal((await f.remote.info()).update_seq, remoteBefore.update_seq)
  assert.equal((await f.local.get("swipe", { conflicts: true }))._conflicts.length, 1)
})

test("multiple settings choices are found before any local archive scan", async t => {
  const f = await fixture(t)
  await f.local.bulkDocs([
    { _id: "animation", _rev: "1-a", list: false }, { _id: "animation", _rev: "1-b", list: true }
  ], { new_edits: false })
  await f.remote.bulkDocs([{ _id: "animation", _rev: "1-c", list: false }], { new_edits: false })
  let scans = 0
  const changes = f.local.changes.bind(f.local)
  f.local.changes = options => { scans++; return changes(options) }
  await assert.rejects(f.migrate(), error => error.documentId === "swipe")
  await f.epoch.resolveSetting({ ...await f.epoch.reviewSetting("swipe"), choice: "remote" })
  await assert.rejects(f.migrate(), error => error.documentId === "animation")
  assert.equal(scans, 0)
  await f.epoch.resolveSetting({ ...await f.epoch.reviewSetting("animation"), choice: "remote" })
  await f.migrate()
  assert.ok(scans > 0)
})

for (const localSeq of [2, 4]) test(`divergent device publication seq ${localSeq} uses domain ordering and preserves the complete winner`, async t => {
  const f = await fixture(t)
  await f.local.put({ ...await f.local.get("swipe"), list: { twoStage: false } })
  const id = "dev_22f450d8f2a8d74b4b2feb6af6ae2e85"
  const device = (seq, rev) => ({ _id: id, _rev: rev, type: "device", schema: 1,
    deviceId: id.slice(4), epoch: 1, seq, name: "Chrome", platform: "chrome", appVersion: "test",
    sharing: true, updatedAt: "2026-10-19T08:00:00Z", windows: [], futureField: { retained: seq } })
  await f.local.bulkDocs([device(localSeq, "1-local")], { new_edits: false })
  await f.remote.bulkDocs([device(3, "1-remote")], { new_edits: false })
  const before = (await f.remote.info()).update_seq
  await f.migrate()
  const pointer = JSON.parse(f.storage.getItem("once:local-database:" + f.local.name))
  const moved = await f.open(pointer.name).get(id, { conflicts: true, revs: true })
  assert.equal(moved.seq, Math.max(localSeq, 3))
  assert.deepEqual(moved.futureField, { retained: Math.max(localSeq, 3) })
  assert.equal(moved._conflicts, undefined)
  assert.ok(moved._revisions.ids.includes("remote"))
  assert.equal((await f.remote.info()).update_seq, before)
  assert.equal((await f.local.get(id))._rev, "1-local")
})

test("malformed device records still block rather than silently discarding data", async t => {
  const f = await fixture(t)
  await f.local.put({ ...await f.local.get("swipe"), list: { twoStage: false } })
  const id = "dev_22f450d8f2a8d74b4b2feb6af6ae2e85"
  await f.local.bulkDocs([{ _id: id, _rev: "1-local", type: "device", seq: 8 }], { new_edits: false })
  await f.remote.bulkDocs([{ _id: id, _rev: "1-remote", type: "device", seq: 3 }], { new_edits: false })
  await assert.rejects(f.migrate(), /ancestry cannot be reconciled/)
  assert.equal(f.storage.getItem("once:local-database:" + f.local.name), null)
})

test("device resolution ranks all live branches by epoch before sequence and rejects same-revision corruption", async () => {
  const { reconcileDevicePublication } = require("../../../packages/persistence/dist/EpochReconciliationPolicy")
  const id = "dev_22f450d8f2a8d74b4b2feb6af6ae2e85"
  const base = { _id: id, type: "device", schema: 1, deviceId: id.slice(4), epoch: 1, seq: 100,
    name: "Chrome", platform: "chrome", updatedAt: "2026-10-19T08:00:00Z", windows: [], sharing: false }
  const local = { ...base, _rev: "2-z" }, newer = { ...base, _rev: "1-a", epoch: 2, seq: 1 }
  const held = { ...base, _rev: "1-canonical" }
  let written
  const source = { get: async () => [{ ok: local }, { ok: newer }] }
  const target = { put: async doc => { written = doc; return { rev: "2-result" } }, get: async () => ({ ...written, _rev: "2-result" }) }
  assert.equal(await reconcileDevicePublication(source, target, local, held, true), true)
  assert.equal(written.epoch, 2)
  assert.equal(written.seq, 1)
  assert.equal(written._rev, "1-canonical")
  written = undefined
  await assert.rejects(reconcileDevicePublication(source, target, local, { ...local, name: "Different bytes" }, true), /same revision/)
  assert.equal(written, undefined)
})
