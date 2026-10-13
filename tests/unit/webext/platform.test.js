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

  // Every event re-reads the active tab of the panel's own window.
  let active = "https://example.com/initial"
  api.tabs.query = async (filter) => {
    assert.deepEqual(filter, { currentWindow: true, active: true })
    return [{ windowId: 1, active: true, url: active }]
  }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const urls = []
  const cleanup = port.onSelectedUrlChanged((url) => urls.push(url))
  await settle()
  active = "https://example.com/activated"
  activated.listeners[0]({ tabId: 2 })
  await settle()
  // A background tab's update is not the selected tab's.
  updated.listeners[0](3, {}, { active: false, windowId: 1, url: "https://example.com/background" })
  await settle()
  assert.deepEqual(urls, ["https://example.com/initial", "https://example.com/activated"])
  cleanup()
  assert.equal(activated.listeners.length, 0)
  assert.equal(updated.listeners.length, 0)
})

test("a late event about the page being left never reports it as open", async () => {
  // One navigation fires several onUpdated events. The browser's lookups
  // answer here newest first, so an older event's reading finishes last.
  const story = "https://example.com/story"
  const comments = "https://news.example.com/item?id=1"
  let current = story
  const pending = []
  const later = (value) => new Promise(resolve => pending.push(() => resolve(value())))
  const updated = event()
  const api = {
    tabs: {
      onActivated: event(),
      onUpdated: updated,
      query: () => later(() => [{ id: 1, windowId: 1, active: true, url: current }]),
      get: () => later(() => ({ id: 1, windowId: 1, active: true, url: current }))
    },
    runtime: { onMessage: event(), async sendMessage() { return null } },
    windows: { getCurrent: () => later(() => ({ id: 1 })) }
  }
  const drainNewestFirst = async () => {
    while (pending.length) {
      pending.pop()()
      await new Promise(resolve => setImmediate(resolve))
    }
  }
  const urls = []
  createWebExtActiveTab(api, {}).onSelectedUrlChanged(url => urls.push(url))
  await drainNewestFirst()
  urls.length = 0

  // The story finishes loading as the toggle sends the tab to its comments.
  updated.listeners[0](1, { status: "complete" }, { id: 1, windowId: 1, active: true, url: story })
  current = comments
  updated.listeners[0](1, { url: comments }, { id: 1, windowId: 1, active: true, url: comments })
  await drainNewestFirst()
  assert.deepEqual(urls, [comments])
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
    // Each event settles before the next: a newer one supersedes a reading still under way.
    activated.listeners[0]({ tabId: 7 })
    await new Promise(resolve => setImmediate(resolve))
    updated.listeners[0](7, { status: "complete" }, tab())
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
