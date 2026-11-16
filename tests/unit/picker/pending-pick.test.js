const test = require("node:test")
const assert = require("node:assert/strict")
const { PendingPick } = require("../../../packages/ui-web/dist/picker/pendingPick")

const EXTENSION = "once@example"
const picked = { onceCommand: "sourcePicked", conf: "{\"stories\":{}}", url: "https://example.test/list" }
const fromTab = (id, extra = {}) => ({ id: EXTENSION, frameId: 0, tab: { id }, ...extra })

test("takes nothing while no pick is waiting", () => {
  const pending = new PendingPick()
  assert.equal(pending.take(picked, fromTab(7), EXTENSION), null)
})

test("takes the result of the tab the picker was injected into, once", () => {
  const pending = new PendingPick()
  pending.begin(7)
  assert.deepEqual(pending.take(picked, fromTab(7), EXTENSION), {
    conf: picked.conf,
    url: picked.url
  })
  assert.equal(pending.waiting, false)
  // A replay of the same message finds no waiting pick.
  assert.equal(pending.take(picked, fromTab(7), EXTENSION), null)
})

test("ignores a result forged from elsewhere and keeps waiting", () => {
  const pending = new PendingPick()
  pending.begin(7)
  assert.equal(pending.take(picked, fromTab(8), EXTENSION), null, "another tab")
  assert.equal(pending.take(picked, fromTab(7, { frameId: 3 }), EXTENSION), null, "a subframe")
  assert.equal(pending.take(picked, fromTab(7, { id: "other@example" }), EXTENSION), null, "another extension")
  assert.equal(pending.take(picked, { id: EXTENSION }, EXTENSION), null, "an extension page, no tab")
  assert.equal(pending.take(picked, undefined, EXTENSION), null, "no sender")
  assert.equal(pending.take(picked, fromTab(7), undefined), null, "unknown own id")
  assert.equal(pending.take({ ...picked, onceCommand: "other" }, fromTab(7), EXTENSION), null)
  assert.equal(pending.waiting, true)
  assert.ok(pending.take(picked, fromTab(7), EXTENSION))
})

test("a cancelled or malformed result from the tab ends the wait without a source", () => {
  const pending = new PendingPick()
  pending.begin(7)
  assert.equal(pending.take({ onceCommand: "sourcePicked", conf: null, url: null }, fromTab(7), EXTENSION), null)
  assert.equal(pending.waiting, false)

  pending.begin(7)
  assert.equal(pending.take({ ...picked, conf: { stories: {} } }, fromTab(7), EXTENSION), null)
  assert.equal(pending.waiting, false)
})

test("a new pick replaces the tab that may answer", () => {
  const pending = new PendingPick()
  pending.begin(7)
  pending.begin(9)
  assert.equal(pending.take(picked, fromTab(7), EXTENSION), null)
  assert.ok(pending.take(picked, fromTab(9), EXTENSION))
})
