const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const Module = require("node:module")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

// The runtime's pure modules import only types from Electron, or value
// modules this stub can stand in for.
const electronStub = {
  app: { getLocale: () => "en-US" },
  protocol: { registerSchemesAsPrivileged() {} }
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
test.after(() => {
  Module._load = originalLoad
  if (originalTs) Module._extensions[".ts"] = originalTs
  else delete Module._extensions[".ts"]
})

const root = path.resolve(__dirname, "../../..")
const extensionsDir = path.join(root, "apps/electron/src/extensions")
const load = (name) => require(path.join(extensionsDir, `${name}.ts`))
const { EXTENSION_IPC, canInjectFrame, isExtensionPageDocument } = require("@once/webext-runtime")
const extensionProtocol = load("ExtensionProtocol")
const { ElectronExtensionContexts } = load("electronContexts")
const { ExtensionHost } = load("ExtensionHost")
const { ExtensionRuntime } = load("ExtensionRuntime")
const { ContentFrames } = load("contentFrames")

test("a registered extension view loses page trust after cross-origin navigation", () => {
  assert.equal(isExtensionPageDocument("moz-extension://other/page.html", "owner"), false)
  const contents = fakeContents(71)
  const frame = { url: "moz-extension://owner/page.html" }
  contents.mainFrame = frame
  const entry = { id: String(contents.id), kind: "background" }
  const host = { extension: { host: "owner" }, contexts: { get: () => entry } }
  const runtime = Object.create(ExtensionRuntime.prototype)
  runtime.contextOwner = new Map([[contents.id, host]])
  const event = { sender: contents, senderFrame: frame }
  assert.equal(runtime.requireContext(event).entry, entry)
  frame.url = "https://example.test/page"
  assert.throws(() => runtime.requireContext(event), /Untrusted extension IPC sender/)
})

test("extension protocols register on first use and replace their handler on re-enable", () => {
  let registered = false
  let replacements = 0
  const target = { protocol: {
    handle() { assert.equal(registered, false); registered = true },
    unhandle() { assert.equal(registered, true); registered = false; replacements++ }
  } }
  extensionProtocol.configureExtensionProtocol(target, () => undefined)
  assert.equal(replacements, 0)
  extensionProtocol.configureExtensionProtocol(target, () => undefined)
  assert.equal(replacements, 1)
  assert.equal(registered, true)
})

function fakeContents(id) {
  const contents = new EventEmitter()
  contents.id = id
  contents.sent = []
  contents.destroyed = false
  contents.isDestroyed = () => contents.destroyed
  contents.send = (channel, message) => contents.sent.push({ channel, message })
  contents.close = () => {
    contents.destroyed = true
    contents.emit("destroyed")
  }
  contents.getURL = () => `moz-extension://host${id}/page.html`
  return contents
}

test("an iframe of an extension page is its own context, reached through the frame", () => {
  const contexts = new ElectronExtensionContexts()
  const page = fakeContents(3)
  const frame = { frameTreeNodeId: 7, detached: false, url: "moz-extension://abc/settings.html", sent: [] }
  frame.send = (channel, message) => frame.sent.push({ channel, message })
  contexts.add(page, "options")
  const entry = contexts.addPageFrame(page, frame, "options")
  assert.deepEqual(
    { id: entry.id, kind: entry.kind, tabId: entry.tabId, frameId: entry.frameId, url: entry.url() },
    { id: "3:7", kind: "options", tabId: -1, frameId: 7, url: frame.url }
  )

  contexts.addListener(entry.id, "runtime", "onMessage", 12, null)
  contexts.emit("runtime", "onMessage", ["hi"])
  assert.equal(page.sent.length, 0)
  assert.deepEqual(frame.sent, [{
    channel: EXTENSION_IPC.event,
    message: { api: "runtime", event: "onMessage", args: ["hi"], listeners: [12] }
  }])

  // The same frame navigating registers again: a fresh context, no listeners.
  contexts.addPageFrame(page, frame, "options")
  assert.equal(contexts.targets("runtime", "onMessage").length, 0)
  assert.notEqual(contexts.get("3:7"), undefined)

  frame.detached = true
  assert.equal(contexts.get("3:7").isDestroyed(), true)
  page.close()
  assert.equal(contexts.get("3:7"), undefined)
  assert.equal(contexts.get("3"), undefined)
})

test("activeTab grant is scoped to a clicked tab and expires on navigation", () => {
  const tab = { id: 4, url: "https://allowed.test/page" }
  const host = Object.create(ExtensionHost.prototype)
  host.extension = { manifest: { permissions: new Set(["activeTab"]), hostPermissions: [] } }
  host.hooks = { tabs: () => [tab] }
  host.activeTabGrants = new Map()
  assert.equal(canInjectFrame(host, 4, tab.url), false)
  host.grantActiveTab(tab)
  assert.equal(canInjectFrame(host, 4, tab.url), true)
  assert.equal(canInjectFrame(host, 4, "https://other.test/frame"), false)
  assert.equal(canInjectFrame(host, 5, tab.url), false)
  host.revokeActiveTab(4)
  assert.equal(canInjectFrame(host, 4, tab.url), false)
})

test("an injection creates the top-frame content context when no manifest script did", () => {
  const sent = []
  const frame = { url: "https://allowed.test/page", detached: false, frameTreeNodeId: 1,
    parent: null, frames: [], send: (channel, message) => sent.push({ channel, message }) }
  const child = { url: "https://allowed.test/frame", detached: false, frameTreeNodeId: 2,
    parent: frame, frames: [], send: (channel, message) => sent.push({ channel, message }) }
  frame.frames.push(child)
  const contents = { id: 4, mainFrame: frame }
  const entries = new Map()
  const host = {
    extension: { id: "test", host: "owner", rawManifest: {}, messages: {},
      manifest: { permissions: new Set(["activeTab"]), hostPermissions: [] } },
    hooks: { tabs: () => [{ id: 4, url: frame.url }] },
    hasActiveTabGrant: () => true,
    worldId: 1000,
    platform: { locale: () => "en-US" },
    contexts: {
      get: (id) => entries.get(id),
      addFrame: (_contents, target) => {
        const entry = { id: `4:${target.frameTreeNodeId}` }
        entries.set(entry.id, entry)
        return entry
      }
    }
  }
  const frames = new ContentFrames()
  frames.init(new Map(), contents, child, "application/pdf")
  frames.ensure(host, contents, 4)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].message.event, "bootstrap")
  assert.equal(sent[0].message.args[0].host, "owner")
  frames.ensure(host, contents, 4)
  assert.equal(sent.length, 1)
  frames.ensure(host, contents, 4, undefined, true)
  assert.equal(sent.length, 1, "a PDF child gets no world")
  frames.init(new Map(), contents, child, "text/html")
  frames.ensure(host, contents, 4, undefined, true)
  assert.equal(sent.length, 2, "same-origin child gets a world for allFrames")
})
