const test = require("node:test")
const assert = require("node:assert/strict")
const { WebExtSecretStorage } = require(
  "../../../packages/platform-webext/dist/storage/WebExtSecretStorage")

function fakeLocalStorage() {
  const data = new Map()
  return {
    data,
    storage: {
      local: {
        get: async (name) => data.has(name) ? { [name]: data.get(name) } : {},
        set: async (entries) => { for (const [name, value] of Object.entries(entries)) data.set(name, value) },
        remove: async (name) => { data.delete(name) }
      },
      // Deliberately absent: a token must never reach the synced area.
      sync: undefined
    }
  }
}

test("a source token lives in local storage only, and an empty value removes it", async () => {
  const api = fakeLocalStorage()
  const storage = new WebExtSecretStorage(api)
  assert.equal(await storage.get("source:src_a"), "")

  await storage.set("source:src_a", "Bearer abc")
  assert.equal(await storage.get("source:src_a"), "Bearer abc")
  assert.deepEqual([...api.data.keys()], ["secret:source:src_a"])

  await storage.set("source:src_a", "")
  assert.equal(await storage.get("source:src_a"), "")
  assert.equal(api.data.size, 0)
})
