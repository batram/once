const assert = require("node:assert/strict")
const fs = require("node:fs")
const Module = require("node:module")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const electronStub = {}
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
test.after(() => {
  Module._load = originalLoad
  if (originalTs) Module._extensions[".ts"] = originalTs
  else delete Module._extensions[".ts"]
})

const root = path.resolve(__dirname, "../../..")
const extensionsDir = path.join(root, "apps/electron/src/extensions")
const load = (name) => require(path.join(extensionsDir, `${name}.ts`))
const { ExtensionPorts } = require("@once/webext-runtime")
const { ElectronExtensionContexts } = load("electronContexts")

function fakeContext(contexts, id, kind, tabId = -1, frameId = 0) {
  const sent = []
  const entry = {
    id: String(id),
    kind,
    tabId,
    frameId,
    listeners: new Map(),
    url: () => `${kind}://${id}`,
    isDestroyed: () => false,
    send: (message) => sent.push(message)
  }
  contexts.addEntry(entry)
  return { entry, sent }
}

// uBlock's element picker is an extension page in a frame of the tab. It is
// the extension's page (it connects to the background like one), yet it
// comes with the tab and shares the frame's transport with content scripts.
test("an extension's own page inside a tab is a page context tied to the tab", () => {
  const contexts = new ElectronExtensionContexts()
  const ports = new ExtensionPorts(contexts)
  const tab = { id: 9, isDestroyed: () => false }
  const frame = { frameTreeNodeId: 4, detached: false, url: "moz-extension://abc/web_accessible_resources/epicker-ui.html", sent: [] }
  frame.send = (channel, message) => frame.sent.push({ channel, message })
  const picker = contexts.addFrame(tab, frame, "abc", 9, 4, "page")
  assert.deepEqual(
    { id: picker.id, kind: picker.kind, tabId: picker.tabId, frameId: picker.frameId },
    { id: "9:4", kind: "page", tabId: 9, frameId: 4 }
  )
  const background = fakeContext(contexts, "bg", "background")
  contexts.addListener(background.entry.id, "runtime", "onConnect", 1, null)
  const portId = ports.connect(picker, "vapi", {}, { tab: { id: 9 } })
  assert.equal(typeof portId, "number")
  assert.equal(background.sent.length, 1)
  ports.post(background.entry.id, portId, "hello")
  assert.deepEqual(frame.sent.at(-1).message, {
    api: "__port", event: "message", args: [{ portId, message: "hello" }], host: "abc"
  })
})
