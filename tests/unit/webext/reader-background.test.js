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
    },
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
      runtime: { onMessage },
      tabs: {
        onRemoved,
        onUpdated,
        async create(options) { calls.push(["create", options]); return { id: 7, status: "complete" } },
        async get() { return { id: 7, status: "complete" } },
        async sendMessage(tabId, message) { calls.push(["sendMessage", tabId, message]) },
      },
      storage: { local: {
        async get(key) { return { [key]: stored[key] } },
        async set(values) { Object.assign(stored, values); calls.push(["store", values]) },
      } },
      scripting: {
        async executeScript(options) { calls.push(["script", options]) },
        async insertCSS(options) { calls.push(["css", options]) },
      },
    },
  }
}

test("injects reader theme, styles, and content after a safe page loads", async () => {
  const fake = createBrowser()
  const cleanup = installReaderBackground(fake.api)
  const handler = fake.onMessage.listeners[0]
  await handler({ onceCommand: "openReader", url: "https://example.com/article", active: false, theme: "dark" }, {})
  assert.deepEqual(fake.calls[0], ["create", { url: "https://example.com/article", active: false }])
  assert.equal(fake.calls.filter(([kind]) => kind === "script").length, 2)
  assert.equal(fake.calls.filter(([kind]) => kind === "css").length, 1)
  await assert.rejects(() => handler({ onceCommand: "openReader", url: "file:///secret" }, {}), /HTTP or HTTPS/)
  cleanup()
  assert.equal(fake.onMessage.listeners.length, 0)
  assert.equal(fake.onRemoved.listeners.length, 0)
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
