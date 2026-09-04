const test = require("node:test")
const assert = require("node:assert/strict")
const { installReaderBackground } = require("../../../packages/webext-shell/dist/readerBackground")

function event() {
  const listeners = []
  return {
    listeners,
    addListener(listener) { listeners.push(listener) },
    removeListener(listener) {
      const index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    }
  }
}

function createBrowser() {
  const onMessage = event()
  const onRemoved = event()
  const onUpdated = event()
  const calls = []
  const stored = {}
  return {
    calls,
    onMessage,
    onRemoved,
    api: {
      runtime: { onMessage, getURL: (path) => `moz-extension://once/${path}` },
      tabs: {
        onRemoved,
        onUpdated,
        async create(options) { calls.push(["create", options]); return { id: 7, status: "complete" } },
        async get() { return { id: 7, status: "complete" } },
        async sendMessage(tabId, message) { calls.push(["sendMessage", tabId, message]) }
      },
      storage: { local: {
        async get(key) { return { [key]: stored[key] } },
        async set(values) { Object.assign(stored, values); calls.push(["store", values]) },
        async remove(key) { stored[key] = undefined; calls.push(["remove", key]) }
      } },
      scripting: {
        async executeScript(options) { calls.push(["script", options]) },
        async insertCSS(options) { calls.push(["css", options]) }
      }
    }
  }
}

test("injects reader theme, styles, and content after a safe page loads", async () => {
  const fake = createBrowser()
  const cleanup = installReaderBackground(fake.api)
  const handler = fake.onMessage.listeners[0]
  await handler({ onceCommand: "openReader", url: "https://example.com/article", active: false, theme: "dark" }, {})
  assert.deepEqual(fake.calls[0], ["create", { url: "https://example.com/article", active: false }])
  assert.equal(fake.calls.filter(([kind]) => kind === "script").length, 2)
  assert.deepEqual(fake.calls.find(([kind]) => kind === "css"), [
    "css",
    { target: { tabId: 7 }, files: ["/reader.css"] }
  ])
  await assert.rejects(() => handler({ onceCommand: "openReader", url: "file:///secret" }, {}), /HTTP or HTTPS/)
  cleanup()
  assert.equal(fake.onMessage.listeners.length, 0)
  assert.equal(fake.onRemoved.listeners.length, 0)
})

test("parks a stored reader document for its page and hands it over once", async () => {
  const fake = createBrowser()
  installReaderBackground(fake.api)
  const handler = fake.onMessage.listeners[0]
  await handler({
    onceCommand: "openStoredReader",
    html: "<!doctype html><title>Stored</title>",
    sourceUrl: "https://example.com/article",
    active: false
  }, {})
  const [, created] = fake.calls.find(([kind]) => kind === "create")
  assert.match(created.url, /^moz-extension:\/\/once\/static\/reader\.html\?token=/)
  assert.equal(created.active, false)
  const token = new URLSearchParams(created.url.split("?")[1]).get("token")
  assert.ok(token)
  // No script injection: the page is the extension's own.
  assert.equal(fake.calls.some(([kind]) => kind === "script"), false)

  assert.deepEqual(await handler({ onceCommand: "getStoredReader", token }, {}), {
    html: "<!doctype html><title>Stored</title>",
    sourceUrl: "https://example.com/article"
  })
  assert.equal(await handler({ onceCommand: "getStoredReader", token }, {}), null, "read once")
  assert.throws(() => handler({ onceCommand: "openStoredReader", html: "" }, {}), /required/)
})

test("stores validated speech rate and transfers speech ownership", async () => {
  const fake = createBrowser()
  installReaderBackground(fake.api)
  const handler = fake.onMessage.listeners[0]
  await handler({ onceCommand: "setReaderTtsRate", rate: 1.7 }, {})
  assert.deepEqual(await handler({ onceCommand: "getReaderTtsRate" }, {}), { rate: 1.7 })
  assert.throws(() => handler({ onceCommand: "setReaderTtsRate", rate: 20 }, {}), /Invalid reader TTS speed/)
  await handler({ onceCommand: "claimReaderTts" }, { tab: { id: 1 } })
  await handler({ onceCommand: "claimReaderTts" }, { tab: { id: 2 } })
  await Promise.resolve()
  assert.deepEqual(fake.calls.at(-1), ["sendMessage", 1, { onceCommand: "stopReaderTts" }])
})
