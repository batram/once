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
  assert.ok(writes.some((doc) =>
    doc._id === "_local/once-conflict-maintenance-v1" && doc.last_seq === 42
  ))
  assert.ok(writes.some((doc) => doc._id === "_local/once-compaction-v1"))
  assert.match(statuses.at(-1).message, /1 database conflict consolidated/)
  assert.deepEqual(errors, [])
})
