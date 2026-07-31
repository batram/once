const test = require("node:test")
const assert = require("node:assert/strict")
const { PouchMaintenanceService } = require("../../../packages/persistence/dist")

test("maintenance merges story conflicts, deletes losing leaves, and compacts once", async () => {
  const winner = {
    _id: "sto_https://example.com/story",
    _rev: "4-winner",
    _conflicts: ["3-loser"],
    type: "rss",
    href: "https://example.com/story",
    title: "Story",
    timestamp: 1,
    read_state: "unread",
    stared: false,
    filter: "",
    sync_updated_at: { read_state: 100 }
  }
  const loser = {
    ...winner,
    _rev: "3-loser",
    _conflicts: undefined,
    read_state: "read",
    sync_updated_at: { read_state: 200 }
  }
  const writes = []
  const deletions = []
  let changeReads = 0
  let compactions = 0
  const db = {
    replicate: { from() {} },
    sync() {},
    async changes(options) {
      assert.equal(options.conflicts, true)
      changeReads++
      return changeReads === 1
        ? { results: [{ doc: winner }], last_seq: 42 }
        : { results: [], last_seq: 42 }
    },
    async get(id, options) {
      if (id.startsWith("_local/")) throw { status: 404 }
      assert.equal(id, winner._id)
      assert.equal(options.rev, "3-loser")
      return loser
    },
    async put(doc) {
      writes.push(doc)
      return { rev: "saved" }
    },
    async bulkDocs(docs) {
      deletions.push(...docs)
      return docs.map(() => ({ ok: true }))
    },
    async compact() { compactions++ }
  }
  const statuses = []
  const errors = []
  const service = new PouchMaintenanceService(
    db,
    (status) => statuses.push(status),
    (error) => errors.push(error)
  )

  await service.run()

  const merged = writes.find((doc) => doc._id === winner._id)
  assert.equal(merged.read_state, "read")
  assert.deepEqual(merged.sync_updated_at, { read_state: 200 })
  assert.equal(merged._conflicts, undefined)
  assert.deepEqual(deletions, [{
    _id: winner._id,
    _rev: "3-loser",
    _deleted: true
  }])
  assert.equal(compactions, 1)
  assert.ok(statuses.some((status) =>
    status.message === "Compacting local database… 0s elapsed"
  ))
  assert.ok(writes.some((doc) =>
    doc._id === "_local/once-conflict-maintenance-v1" && doc.last_seq === 42
  ))
  assert.ok(writes.some((doc) => doc._id === "_local/once-compaction-v1"))
  assert.match(statuses.at(-1).message, /1 database conflict consolidated/)
  assert.deepEqual(errors, [])
})

test("maintenance keeps established legacy remote state over a feed-created local default", async () => {
  const localWinner = {
    _id: "sto_https://example.com/legacy",
    _rev: "1-local",
    _conflicts: ["8-remote"],
    type: "rss",
    href: "https://example.com/legacy",
    title: "Story",
    timestamp: 1,
    read_state: "unread",
    stared: false,
    filter: ""
  }
  const remoteLeaf = {
    ...localWinner,
    _rev: "8-remote",
    _conflicts: undefined,
    read_state: "skipped",
    stared: true,
    filter: "remote-filter"
  }
  const writes = []
  let reads = 0
  const db = {
    async changes() {
      reads++
      return reads === 1
        ? { results: [{ doc: localWinner }], last_seq: 2 }
        : { results: [], last_seq: 2 }
    },
    async get(id, options) {
      if (id.startsWith("_local/")) throw { status: 404 }
      assert.equal(options.rev, remoteLeaf._rev)
      return remoteLeaf
    },
    async put(doc) {
      writes.push(doc)
      return { rev: "saved" }
    },
    async bulkDocs(docs) {
      return docs.map(() => ({ ok: true }))
    },
    async compact() {}
  }

  await new PouchMaintenanceService(db, () => {}, assert.fail).run()

  const merged = writes.find((doc) => doc._id === localWinner._id)
  assert.equal(merged.read_state, "skipped")
  assert.equal(merged.stared, true)
  assert.equal(merged.filter, "remote-filter")
})

test("maintenance scans a large existing database in bounded batches", async () => {
  const batches = [
    Array.from({ length: 100 }, (_, index) => ({
      doc: { _id: `sto_local_${index}`, read_state: "unread" }
    })),
    Array.from({ length: 37 }, (_, index) => ({
      doc: { _id: `sto_local_${index + 100}`, read_state: "unread" }
    })),
    []
  ]
  const requests = []
  let batch = 0
  const db = {
    async changes(options) {
      requests.push(options)
      const results = batches[batch]
      batch++
      return { results, last_seq: batch * 100 }
    },
    async get() {
      throw { status: 404 }
    },
    async put() {
      return { rev: "saved" }
    },
    async bulkDocs() {
      return []
    },
    async compact() {}
  }

  await new PouchMaintenanceService(db, () => {}, assert.fail).run()

  assert.deepEqual(requests.map(({ since, limit }) => ({ since, limit })), [
    { since: 0, limit: 100 },
    { since: 100, limit: 100 },
    { since: 200, limit: 100 }
  ])
})
