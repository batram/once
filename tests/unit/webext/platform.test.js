const test = require("node:test")
const assert = require("node:assert/strict")
const { createWebExtActiveTab, createWebExtHistorySubscription } = require("../../../packages/platform-webext/dist/webextPorts")

function event() {
  const listeners = []
  return {
    listeners,
    addListener(listener) { listeners.push(listener) },
    removeListener(listener) { listeners.splice(listeners.indexOf(listener), 1) },
  }
}

test("maps tab dispositions and tracks only the selected tab in the current window", async () => {
  const activated = event()
  const updated = event()
  const created = []
  const opened = []
  const api = {
    tabs: {
      onActivated: activated,
      onUpdated: updated,
      create(options) { created.push(options) },
      async get(id) { return { id, windowId: 1, active: true, url: "https://example.com/activated" } },
      async query() { return [{ windowId: 1, active: true, url: "https://example.com/initial" }] },
    },
    windows: { async getCurrent() { return { id: 1 } } },
  }
  const port = createWebExtActiveTab(api, { open(url, target) { opened.push({ url, target }) } })
  port.openUrl("https://example.com/background", "middle")
  port.openUrl("https://example.com/current", "_self")
  port.openUrl("https://example.com/window", "blank")
  assert.deepEqual(created, [
    { url: "https://example.com/background", active: false },
    { url: "https://example.com/current", active: true },
  ])
  assert.deepEqual(opened, [{ url: "https://example.com/window", target: "blank" }])

  const urls = []
  const cleanup = port.onSelectedUrlChanged((url) => urls.push(url))
  await Promise.resolve()
  await activated.listeners[0]({ tabId: 2 })
  await updated.listeners[0](2, {}, { active: true, windowId: 2, url: "https://example.com/other" })
  assert.deepEqual(urls, ["https://example.com/initial", "https://example.com/activated"])
  cleanup()
  assert.equal(activated.listeners.length, 0)
  assert.equal(updated.listeners.length, 0)
})

test("accepts only undo and redo history commands and removes its listener", () => {
  const onMessage = event()
  const subscribe = createWebExtHistorySubscription({ runtime: { onMessage } })
  const actions = []
  const cleanup = subscribe((action) => actions.push(action))
  onMessage.listeners[0]({ onceCommand: "history", action: "undo" })
  onMessage.listeners[0]({ onceCommand: "history", action: "redo" })
  onMessage.listeners[0]({ onceCommand: "other", action: "undo" })
  assert.deepEqual(actions, ["undo", "redo"])
  cleanup()
  assert.equal(onMessage.listeners.length, 0)
})
