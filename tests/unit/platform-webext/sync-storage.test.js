const test = require("node:test")
const assert = require("node:assert/strict")
const { WebExtSyncStorage } = require(
  "../../../packages/platform-webext/dist/storage/WebExtSyncStorage")

test("an unset browser sync URL is normalized to an empty string", async () => {
  const storage = new WebExtSyncStorage({
    storage: { sync: { get: async () => ({}), set: async () => {} } }
  })
  assert.equal(await storage.getSyncUrl(), "")
})

test("a stored browser sync URL is preserved", async () => {
  const storage = new WebExtSyncStorage({
    storage: { sync: { get: async () => ({ sync_url: "https://sync.test/db" }),
      set: async () => {} } }
  })
  assert.equal(await storage.getSyncUrl(), "https://sync.test/db")
})
