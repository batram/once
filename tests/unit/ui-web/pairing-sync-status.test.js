const test = require("node:test")
const assert = require("node:assert/strict")
const { waitForPairingSync } = require("../../../packages/ui-web/dist/settings/pairingSyncStatus")

test("pairing waits for replication, reports failure and releases its subscription", async () => {
  let status = { state: "syncing", message: "Connecting" }
  const listeners = new Set()
  const client = { getSyncStatus: () => status, subscribe: (_name, fn) => { listeners.add(fn); return () => listeners.delete(fn) } }
  const pending = waitForPairingSync(client)
  assert.equal(listeners.size, 1)
  status = { state: "error", message: "Authentication failed" }
  for (const fn of listeners) fn()
  await assert.rejects(pending, /Authentication failed/)
  assert.equal(listeners.size, 0)
  status = { state: "up-to-date" }
  await waitForPairingSync(client)
  assert.equal(listeners.size, 0)
})
