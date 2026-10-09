const test = require("node:test")
const assert = require("node:assert/strict")
const { installReaderBackground } = require("../../../packages/webext-shell/dist/readerBackground")
const panelSender = { url: "moz-extension://once/static/sidepanel.html" }
const readerSender = { url: "moz-extension://once/static/reader.html?token=test" }
const contentSender = id => ({ tab: { id }, url: "https://example.com/article" })

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
    stored,
    onMessage,
    onRemoved,
    api: {
      runtime: { onMessage, getURL: (path) => `moz-extension://once/${path.replace(/^\//, "")}` },
      tabs: {
        onRemoved,
        onUpdated,
        async create(options) { calls.push(["create", options]); return { id: 7, status: "complete" } },
        async get() { return { id: 7, status: "complete" } },
        async sendMessage(tabId, message) { calls.push(["sendMessage", tabId, message]) }
      },
      storage: { local: {
        async get(keys) {
          return Object.fromEntries([keys].flat().map((key) => [key, stored[key]]))
        },
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
  await handler({ onceCommand: "openReader", url: "https://example.com/article", active: false, theme: "dark" }, panelSender)
  assert.deepEqual(fake.calls[0], ["create", { url: "https://example.com/article", active: false }])
  assert.equal(fake.calls.filter(([kind]) => kind === "script").length, 2)
  assert.deepEqual(fake.calls.find(([kind]) => kind === "css"), [
    "css",
    { target: { tabId: 7 }, files: ["/reader.css"] }
  ])
  await assert.rejects(() => handler({ onceCommand: "openReader", url: "file:///secret" }, panelSender), /HTTP or HTTPS/)
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
  }, panelSender)
  const [, created] = fake.calls.find(([kind]) => kind === "create")
  assert.match(created.url, /^moz-extension:\/\/once\/static\/reader\.html\?token=/)
  assert.equal(created.active, false)
  assert.equal(new URL(created.url).searchParams.get("sourceUrl"), "https://example.com/article")
  const token = new URLSearchParams(created.url.split("?")[1]).get("token")
  assert.ok(token)
  // No script injection: the page is the extension's own.
  assert.equal(fake.calls.some(([kind]) => kind === "script"), false)

  assert.deepEqual(await handler({ onceCommand: "getStoredReader", token }, readerSender), {
    html: "<!doctype html><title>Stored</title>",
    sourceUrl: "https://example.com/article"
  })
  assert.equal(await handler({ onceCommand: "getStoredReader", token }, readerSender), null, "read once")
  assert.throws(() => handler({ onceCommand: "openStoredReader", html: "" }, panelSender), /required/)
})

test("stores validated speech speeds per voice and transfers speech ownership", async () => {
  const fake = createBrowser()
  installReaderBackground(fake.api)
  const handler = fake.onMessage.listeners[0]
  const preferences = { voice: "en-voice", rates: { "": 1.2, "en-voice": 2.5 } }
  await handler({ onceCommand: "setReaderTtsPreferences", preferences }, readerSender)
  assert.deepEqual(await handler({ onceCommand: "getReaderTtsPreferences" }, contentSender(1)), preferences)
  assert.throws(
    () => handler({ onceCommand: "setReaderTtsPreferences", preferences: { voice: "", rates: { "": 20 } } }, readerSender),
    /Invalid reader TTS settings/
  )
  await handler({ onceCommand: "claimReaderTts" }, contentSender(1))
  await handler({ onceCommand: "claimReaderTts" }, contentSender(2))
  await Promise.resolve()
  assert.deepEqual(fake.calls.at(-1), ["sendMessage", 1, { onceCommand: "stopReaderTts" }])
})

test("rejects privileged commands from the wrong sender document", async () => {
  const fake = createBrowser()
  installReaderBackground(fake.api)
  const handler = fake.onMessage.listeners[0]
  assert.equal(handler({ onceCommand: "openReader", url: "https://example.com" }, readerSender), undefined)
  assert.equal(handler({ onceCommand: "openStoredReader", html: "secret" }, contentSender(1)), undefined)
  assert.equal(handler({ onceCommand: "getStoredReader", token: "secret" }, panelSender), undefined)
  assert.equal(handler({ onceCommand: "setReaderTtsPreferences", preferences: { voice: "", rates: {} } }, panelSender), undefined)
  assert.equal(handler({ onceCommand: "claimReaderTts" }, { tab: { id: 1 }, url: "moz-extension://once/static/sidepanel.html" }), undefined)
  assert.deepEqual(fake.calls, [])
})

test("a speed stored before speeds were per voice becomes the default voice's", async () => {
  const fake = createBrowser()
  installReaderBackground(fake.api)
  const handler = fake.onMessage.listeners[0]
  fake.stored.onceReaderTtsRate = 1.7
  assert.deepEqual(await handler({ onceCommand: "getReaderTtsPreferences" }, readerSender), {
    voice: "",
    rates: { "": 1.7 }
  })
})
