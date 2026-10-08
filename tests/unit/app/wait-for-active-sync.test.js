const test = require("node:test")
const assert = require("node:assert/strict")
const { LocalEventBus } = require("../../../packages/app/dist/EventBus")
const { waitForActiveSync } = require("../../../packages/app/dist/waitForActiveSync")

test("active sync waits for completion or failure and removes its subscription", async () => {
  for (const next of ["up-to-date", "error", "retrying", "disabled"]) {
    const events = new LocalEventBus()
    let state = "syncing", settled = false
    const waiting = waitForActiveSync(() => ({ state }), events).then(() => { settled = true })
    await Promise.resolve()
    assert.equal(settled, false)
    state = next
    events.publish("syncStatusChanged", { state, message: state })
    await waiting
    assert.equal(settled, true)
    assert.equal(events.handlers.syncStatusChanged.length, 0)
  }
})

test("stalled active sync is bounded, while other states return immediately", async () => {
  const events = new LocalEventBus()
  await waitForActiveSync(() => ({ state: "syncing" }), events, 1)
  assert.equal(events.handlers.syncStatusChanged.length, 0)
  for (const state of ["disabled", "connecting", "up-to-date", "retrying", "error"]) {
    await waitForActiveSync(() => ({ state }), events)
    assert.equal(events.handlers.syncStatusChanged.length, 0)
  }
})
