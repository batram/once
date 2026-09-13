const assert = require("node:assert/strict")
const fs = require("node:fs")
const Module = require("node:module")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const originalTs = Module._extensions[".ts"]
Module._extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8")
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename
  }).outputText
  module._compile(output, filename)
}
test.after(() => {
  if (originalTs) Module._extensions[".ts"] = originalTs
  else delete Module._extensions[".ts"]
})

const root = path.resolve(__dirname, "../../..")
const { PreloadApi, adoptBridge } = require(path.join(root, "apps/electron/src/extensions/preloadRuntime.ts"))
const { EXTENSION_API_SURFACE, INTERNAL_API, settleInvoke, unwrapInvoke } = require(
  path.join(root, "apps/electron/src/extensions/protocol.ts")
)

const init = {
  id: "ext@test", host: "abc", kind: "page", manifest: { name: "Test" }, messages: {}, uiLanguage: "en"
}

// A transport that hands out port ids and records what main would be told.
function fakeTransport({ connectId = 1 } = {}) {
  const calls = []
  return {
    calls,
    invoke: async (api, method, args) => {
      calls.push({ api, method, args })
      if (api === INTERNAL_API.port && method === "connect") return connectId
      return undefined
    },
    reply: () => {},
    listen: () => {}
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test("a Chrome-style callback sees a rejection as runtime.lastError, unread ones warn", async (t) => {
  const warnings = t.mock.method(console, "warn", () => {})
  const listeners = []
  globalThis.__onceExtensionApi = {
    runtime: { lastError: undefined, getURL: (p) => `ext://${p}` },
    tabs: {
      sendMessage: async () => { throw new Error("Could not establish connection. Receiving end does not exist.") },
      query: async () => [{ id: 3 }],
      onUpdated: { addListener: (listener) => listeners.push(listener) }
    }
  }
  adoptBridge()
  t.after(() => { delete globalThis.browser; delete globalThis.chrome })
  const { chrome } = globalThis

  // SponsorBlock's tab-update callback, verbatim: read it and stay silent.
  let seen
  await new Promise((resolve) => chrome.tabs.sendMessage(3, { message: "update" }, () => {
    seen = chrome.runtime.lastError
    resolve()
  }))
  assert.deepEqual(seen, { message: "Could not establish connection. Receiving end does not exist." })
  assert.equal(chrome.runtime.lastError, undefined, "cleared once the callback returns")
  assert.equal(warnings.mock.callCount(), 0)

  await new Promise((resolve) => chrome.tabs.sendMessage(3, {}, resolve))
  assert.equal(warnings.mock.callCount(), 1)
  assert.match(warnings.mock.calls[0].arguments[0], /^Unchecked runtime.lastError: Could not/)

  const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve))
  assert.deepEqual(tabs, [{ id: 3 }])
  assert.deepEqual(await chrome.tabs.query({}), [{ id: 3 }], "promise style is untouched")
  assert.equal(chrome.runtime.getURL("a"), "ext://a", "synchronous calls pass through")
  const listener = () => {}
  chrome.tabs.onUpdated.addListener(listener)
  assert.deepEqual(listeners, [listener], "a listener is not a callback")
})

test("an API rejection crosses IPC as data and rejects again in the page", async () => {
  // Thrown out of an ipcMain handler, Electron logs a stack trace for every
  // "Receiving end does not exist" and prefixes the message the page sees.
  assert.deepEqual(await settleInvoke(() => 42), { ok: true, value: 42 })
  assert.deepEqual(await settleInvoke(async () => "later"), { ok: true, value: "later" })
  const failed = await settleInvoke(() => { throw new Error("Invalid tab ID: 9") })
  assert.deepEqual(failed, { ok: false, error: "Invalid tab ID: 9" })
  assert.deepEqual(await settleInvoke(() => Promise.reject("plain")), { ok: false, error: "plain" })

  assert.equal(unwrapInvoke({ ok: true, value: 42 }), 42)
  assert.throws(() => unwrapInvoke(failed), { message: "Invalid tab ID: 9" })
})

test("a port's own disconnect() reaches the far end only; the far end's reaches this one", async () => {
  const transport = fakeTransport({ connectId: 7 })
  const api = new PreloadApi(init, EXTENSION_API_SURFACE, transport)
  const browser = api.build()
  const port = browser.runtime.connect({ name: "pane" })
  const disconnects = []
  port.onDisconnect.addListener(() => disconnects.push("local"))
  await settle()

  // uBlock's dashboard panes idle their port out this way and, inside an
  // iframe, treat a disconnect event as the page being torn down.
  port.disconnect()
  await settle()
  assert.deepEqual(disconnects, [])
  assert.deepEqual(transport.calls.at(-1), {
    api: INTERNAL_API.port, method: "disconnect", args: [{ portId: 7 }]
  })

  const second = browser.runtime.connect({ name: "pane" })
  second.onDisconnect.addListener(() => disconnects.push("far"))
  await settle()
  api.handleEvent({ api: INTERNAL_API.port, event: "disconnect", args: [{ portId: 7 }] })
  assert.deepEqual(disconnects, ["far"])
})

test("a connect nobody answers fires onDisconnect on the connecting end", async () => {
  const transport = fakeTransport({ connectId: null })
  const api = new PreloadApi(init, EXTENSION_API_SURFACE, transport)
  const port = api.build().runtime.connect({ name: "nobody" })
  const disconnects = []
  port.onDisconnect.addListener(() => disconnects.push("local"))
  await settle()
  assert.deepEqual(disconnects, ["local"])
})
