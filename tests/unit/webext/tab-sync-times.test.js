const test = require("node:test")
const assert = require("node:assert/strict")
const { installTabSyncTimes } = require("../../../packages/webext-shell/dist/tabSyncTimes")

const event = () => { const handlers = []; return { addListener: fn => handlers.push(fn), emit: value => handlers.forEach(fn => fn(value)) } }

test("first activation after startup and after moving windows captures the outgoing tab", async () => {
  const saved = {}
  let windows = [{ id: 1, tabs: [{ id: 10, active: true, url: "https://example.com/a" }, { id: 11, url: "https://example.com/b" }] }]
  const api = {
    storage: { session: { get: async () => structuredClone(saved), set: async value => Object.assign(saved, value) } },
    tabs: Object.fromEntries(["onCreated", "onActivated", "onRemoved", "onUpdated", "onAttached", "onDetached"].map(key => [key, event()])),
    webNavigation: { onCommitted: event() },
    windows: { onRemoved: event(), onFocusChanged: event(), getAll: async () => structuredClone(windows) }
  }
  const source = installTabSyncTimes(api)
  const left = []
  source.onDeselected(id => left.push(id))
  await source.snapshot()
  api.tabs.onActivated.emit({ tabId: 11, windowId: 1 })
  await source.snapshot()
  assert.deepEqual(left, ["10"])
  windows = [{ id: 2, tabs: [{ id: 11, active: true, url: "https://example.com/b" }, { id: 12, url: "https://example.com/c" }] }]
  api.tabs.onAttached.emit({})
  await source.snapshot()
  api.tabs.onActivated.emit({ tabId: 12, windowId: 2 })
  await source.snapshot()
  assert.deepEqual(left, ["10", "11"])
  assert.deepEqual(saved["once:tabsync:times"].active, { 2: 12 })
})
