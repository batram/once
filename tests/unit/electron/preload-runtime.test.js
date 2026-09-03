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
const { PreloadApi } = require(path.join(root, "apps/electron/src/extensions/preloadRuntime.ts"))
const { EXTENSION_API_SURFACE, INTERNAL_API } = require(path.join(root, "apps/electron/src/extensions/protocol.ts"))

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
