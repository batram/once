const test = require("node:test")
const assert = require("node:assert/strict")
const { installReaderBackground } = require("../../../packages/webext-shell/dist/readerBackground")
test.beforeEach(context => context.mock.method(globalThis, "fetch", async () => new Response(null, { headers: { "content-type": "text/html" } })))

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

function createBrowser({ responseHeaders } = {}) {
  const onMessage = event()
  const onRemoved = event()
  const onUpdated = event()
  const onHeadersReceived = event()
  const onCompleted = event()
  const calls = []
  const stored = {}
  return {
    calls,
    stored,
    onMessage,
    onRemoved,
    onHeadersReceived,
    api: {
      runtime: { onMessage, getURL: (path) => `moz-extension://once/${path.replace(/^\//, "")}` },
      webRequest: { onHeadersReceived },
      webNavigation: { onCompleted },
      tabs: {
        onRemoved,
        onUpdated,
        async create(options) {
          calls.push(["create", options])
          // The navigation's response headers arrive while the tab loads.
          if (responseHeaders) for (const listener of onHeadersReceived.listeners) listener({ tabId: 7, statusCode: 200, url: options.url, responseHeaders })
          queueMicrotask(() => { for (const listener of onCompleted.listeners) listener({ tabId: 7, frameId: 0, url: options.url }) })
          return { id: 7, status: "complete" }
        },
        async update(tabId, options) { calls.push(["update", tabId, options]) },
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
  assert.equal(fake.onHeadersReceived.listeners.length, 0, "the header watch ends with the open")
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


test("a PDF response moves the tab to the extension reader without injecting into a privileged PDF viewer", async context => {
  const probe = context.mock.method(globalThis, "fetch", async () => { throw new Error("no probe expected") })
  const fake = createBrowser({ responseHeaders: [{ name: "Content-Type", value: "application/pdf" }] })
  installReaderBackground(fake.api)
  await fake.onMessage.listeners[0]({ onceCommand: "openReader", url: "https://example.test/document", active: false, theme: "dark" }, panelSender)
  assert.deepEqual(fake.calls.find(([kind]) => kind === "create")[1], { url: "https://example.test/document", active: false })
  const [, tabId, updated] = fake.calls.find(([kind]) => kind === "update")
  assert.equal(tabId, 7)
  const url = new URL(updated.url)
  assert.equal(url.pathname, "/static/reader.html")
  assert.equal(url.searchParams.get("pdf"), "1")
  assert.equal(url.searchParams.get("sourceUrl"), "https://example.test/document")
  assert.equal(url.searchParams.get("theme"), "dark")
  assert.equal(fake.calls.filter(([kind]) => kind === "script" || kind === "css").length, 0)
  assert.equal(probe.mock.callCount(), 0)
})

test("a PDF the browser served without reporting headers is still found by the fallback probe", async context => {
  context.mock.method(globalThis, "fetch", async () => new Response(null, { headers: { "content-type": "application/pdf" } }))
  const fake = createBrowser()
  installReaderBackground(fake.api)
  await fake.onMessage.listeners[0]({ onceCommand: "openReader", url: "https://example.test/document", active: true, theme: "light" }, panelSender)
  assert.equal(new URL(fake.calls.find(([kind]) => kind === "update")[2].url).searchParams.get("pdf"), "1")
  assert.equal(fake.calls.filter(([kind]) => kind === "script" || kind === "css").length, 0)
})
