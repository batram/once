const test = require("node:test")
const assert = require("node:assert/strict")
const { PouchListStore } = require("../../../packages/persistence/dist")

test("returns a missing list fallback without persisting a settings change", async () => {
  const writes = []
  const store = new PouchListStore({
    async get() { throw { status: 404 } },
    async put(doc) { writes.push(doc) }
  })
  const fallback = ["https://example.com/default"]

  assert.deepEqual(await store.get("story_sources", fallback), fallback)
  assert.deepEqual(writes, [])
})

test("rejects list database failures instead of silently using defaults", async () => {
  const store = new PouchListStore({
    async get() { throw new Error("database unavailable") },
    async put() {}
  })

  await assert.rejects(
    store.get("story_sources", []),
    /database unavailable/
  )
})

test("does not create a revision when a stored list is unchanged", async () => {
  let writes = 0
  const store = new PouchListStore({
    async get() {
      return { _id: "filter_list", _rev: "4-current", list: ["one", "two"] }
    },
    async put() { writes++ }
  })

  await store.set("filter_list", ["one", "two"])

  assert.equal(writes, 0)
})
