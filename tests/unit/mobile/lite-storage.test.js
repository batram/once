const test = require("node:test")
const assert = require("node:assert/strict")
const { lite } = require("./lite-support")
const { LiteJsonStore } = lite("liteStorage")

test("large store reads yield before consuming the next bounded chunk", async () => {
  let reads = 0
  let readsAtTurn
  const pieces = ['{"value":"', "large 🐢 store", '"}']
  const store = new LiteJsonStore({ request: async () => ({ chunked: "snapshot" }) }, "/store", {
    readChunk(token, maxBytes) {
      assert.equal(token, "snapshot")
      assert.ok(maxBytes <= 256 * 1024)
      const text = pieces[reads++]
      return JSON.stringify({ text, done: reads === pieces.length })
    }
  })
  setTimeout(() => { readsAtTurn = reads }, 0)
  assert.deepEqual(await store.read("storage.json"), { value: "large 🐢 store" })
  assert.equal(readsAtTurn, 1, "another renderer task runs before the second read")
  assert.equal(reads, 3)
})

test("a failed chunk rejects the read without returning partial JSON", async () => {
  const store = new LiteJsonStore({ request: async () => ({ chunked: "gone" }) }, "/store", {
    readChunk: () => JSON.stringify({ error: "snapshot closed" })
  })
  await assert.rejects(store.read("storage.json"), /snapshot closed/)
})

test("inline and absent store values need no synchronous file interface", async () => {
  const store = new LiteJsonStore({ request: async (_method, { name }) =>
    ({ json: name === "present" ? '{"ok":true}' : null }) }, "/store")
  assert.deepEqual(await store.read("present"), { ok: true })
  assert.equal(await store.read("absent"), undefined)
})
