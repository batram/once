// The frame preload's insertCSS/removeCSS handling, loaded against a stub
// Electron. Electron can only remove author-origin sheets again, so every
// inserted sheet must be one, and removeCSS must reach the key insertCSS got.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const Module = require("node:module")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const root = path.resolve(__dirname, "../../..")
const init = {
  id: "ext@test", host: "abc", kind: "content", worldId: 7, scripts: [],
  manifest: { name: "Test" }, messages: {}, uiLanguage: "en"
}

const webFrameCalls = []
let nextKey = 0
const electronStub = {
  contextBridge: { exposeInIsolatedWorld() {}, exposeInMainWorld() {}, executeInMainWorld() {} },
  ipcRenderer: {
    handlers: new Map(),
    sendSync: (channel) => (channel === EXTENSION_IPC.contentInit ? [init] : undefined),
    on(channel, handler) { this.handlers.set(channel, handler) },
    invoke: async () => undefined,
    send() {}
  },
  webFrame: {
    setIsolatedWorldInfo() {},
    executeJavaScriptInIsolatedWorld: async () => undefined,
    executeJavaScript: async () => undefined,
    insertCSS(css, options) {
      const key = `key-${++nextKey}`
      webFrameCalls.push({ call: "insertCSS", css, options, key })
      return key
    },
    removeInsertedCSS(key) { webFrameCalls.push({ call: "removeInsertedCSS", key }) }
  }
}

const originalLoad = Module._load
const originalTs = Module._extensions[".ts"]
Module._load = function load(request, parent, isMain) {
  if (request === "electron") return electronStub
  return originalLoad.call(this, request, parent, isMain)
}
Module._extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8")
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename
  }).outputText
  module._compile(output, filename)
}
globalThis.document = { contentType: "text/html", readyState: "complete", documentElement: {}, addEventListener() {} }
globalThis.window = { addEventListener() {} }
test.after(() => {
  Module._load = originalLoad
  if (originalTs) Module._extensions[".ts"] = originalTs
  else delete Module._extensions[".ts"]
  delete globalThis.document
  delete globalThis.window
})

// Only loadable once the TypeScript loader above is installed; the stub's
// sendSync reads EXTENSION_IPC lazily, when the preload asks for its inits.
const { EXTENSION_IPC, INTERNAL_API } = require(path.join(root, "apps/electron/src/extensions/protocol.ts"))
require(path.join(root, "apps/electron/src/extensions/contentPreload.ts"))
const onEvent = electronStub.ipcRenderer.handlers.get(EXTENSION_IPC.event)
const inject = (event, css, host = init.host) =>
  onEvent({}, { host, api: INTERNAL_API.content, event, args: [{ css }] })

test("removeCSS removes the author-origin sheet insertCSS inserted for the same code", () => {
  assert.equal(typeof onEvent, "function")
  const css = "body { outline: 5px solid green }"
  inject("insertCSS", css)
  assert.deepEqual(webFrameCalls, [{ call: "insertCSS", css, options: { cssOrigin: "author" }, key: "key-1" }])

  inject("insertCSS", css)
  assert.equal(webFrameCalls.length, 1, "the same code is inserted once per world")

  inject("removeCSS", css, "other-host")
  assert.equal(webFrameCalls.length, 1, "an unknown host is ignored")

  inject("removeCSS", css)
  assert.deepEqual(webFrameCalls.at(-1), { call: "removeInsertedCSS", key: "key-1" })

  inject("removeCSS", css)
  assert.equal(webFrameCalls.length, 2, "a removed sheet is not removed twice")

  inject("insertCSS", css)
  assert.deepEqual(webFrameCalls.at(-1), { call: "insertCSS", css, options: { cssOrigin: "author" }, key: "key-2" })
})
