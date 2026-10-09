const test = require("node:test")
const assert = require("node:assert/strict")
const { createWebExtActiveTab, createWebExtHistorySubscription } = require("../../../packages/platform-webext/dist/webextPorts")

function event() {
  const listeners = []
  return {
    listeners,
    addListener(listener) { listeners.push(listener) },
    removeListener(listener) { listeners.splice(listeners.indexOf(listener), 1) }
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
      async query() { return [{ windowId: 1, active: true, url: "https://example.com/initial" }] }
    },
    runtime: { onMessage: event(), async sendMessage() { return null } },
    windows: { async getCurrent() { return { id: 1 } } }
  }
  const port = createWebExtActiveTab(api, { open(url, target) { opened.push({ url, target }) } })
  port.openUrl("https://example.com/background", "middle")
  port.openUrl("https://example.com/current", "_self")
  port.openUrl("https://example.com/window", "blank")
  assert.deepEqual(created, [
    { url: "https://example.com/background", active: false },
    { url: "https://example.com/current", active: true }
  ])
  assert.deepEqual(opened, [{ url: "https://example.com/window", target: "blank" }])

  const urls = []
  const cleanup = port.onSelectedUrlChanged((url) => urls.push(url))
  await new Promise(resolve => setImmediate(resolve))
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

for (const scheme of ["moz-extension", "chrome-extension"]) {
  test(`${scheme} stored readers select the original story on opening and switching tabs`, async () => {
    const reader = `${scheme}://once/static/reader.html`
    const source = "https://www.stephendiehl.com/posts/dependently_typed_future/?a=1&b=two%20words#section"
    let selectedUrl = `${reader}?${new URLSearchParams({ token: "saved", sourceUrl: source })}`
    const activated = event()
    const updated = event()
    const navigationRequests = []
    const tab = () => ({ id: 7, windowId: 1, active: true, url: selectedUrl })
    const api = {
      runtime: {
        onMessage: event(),
        getURL: path => `${scheme}://once/${path}`,
        async sendMessage(message) { navigationRequests.push(message); return null }
      },
      tabs: { onActivated: activated, onUpdated: updated, async query() { return [tab()] }, async get() { return tab() } },
      windows: { async getCurrent() { return { id: 1 } } }
    }
    const urls = []
    const cleanup = createWebExtActiveTab(api, {}).onSelectedUrlChanged(url => urls.push(url))
    await new Promise(resolve => setImmediate(resolve))
    await activated.listeners[0]({ tabId: 7 })
    await updated.listeners[0](7, { status: "complete" }, tab())
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(urls, [source, source, source])
    assert.ok(navigationRequests.every(message => message.url === source))

    for (const value of [
      `${scheme}://other/static/reader.html?sourceUrl=${encodeURIComponent(source)}`,
      `https://example.com/static/reader.html?sourceUrl=${encodeURIComponent(source)}`,
      `${reader}?sourceUrl=javascript%3Aalert(1)`,
      `${reader}?sourceUrl=not-a-url`,
      `${reader}?token=old-reader`
    ]) {
      selectedUrl = value
      await activated.listeners[0]({ tabId: 7 })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(urls.at(-1), value)
    }
    cleanup()
  })
}
