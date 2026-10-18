const test = require("node:test")
const assert = require("node:assert/strict")
const { TabStates } = require("../../../packages/app/dist/tabsync/TabStates")
const { publicationFingerprint } = require("../../../packages/app/dist/tabsync/tabPublication")

test("sampling unchanged reader state does not change its publication fingerprint", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 10000 })
  let fraction = 0.25
  const states = new TabStates({ readerPosition: async () => ({ fraction, anchor: { index: 3, text: "Third" } }) })
  const tab = { id: "a", navSeq: 1, url: "https://example.test/article", mode: "reader", active: true, activityAt: new Date(1000).toISOString() }
  const windows = [{ id: "w", tabs: [tab] }]
  const fingerprint = () => publicationFingerprint({ epoch: 1, name: "Phone", sharing: true, appVersion: "test", windows: states.attach(windows) })
  assert.equal(await states.capture(tab), true)
  const first = fingerprint()
  t.mock.timers.tick(15000)
  assert.equal(await states.capture(tab), false)
  assert.equal(fingerprint(), first)
  fraction = 0.5
  assert.equal(await states.capture(tab), true)
  assert.notEqual(fingerprint(), first)
})
