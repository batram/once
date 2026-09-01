const assert = require("node:assert/strict")
const fs = require("node:fs")
const Module = require("node:module")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

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
const { contentScriptsFor, ExtensionFiles } = load("contentScripts")
const { isWebAccessible, serveExtensionRequest } = load("ExtensionProtocol")
const { loadUnpackedExtension } = load("LoadedExtension")
const { extensionUrl } = load("ExtensionScheme")
const { ExtensionContexts } = load("ExtensionContexts")
const { ExtensionPorts } = load("ExtensionPorts")
const { parseWebExtensionManifest } = require("../../../packages/core/dist/webext/manifest")

const fixture = path.join(root, "tests/fixtures/extensions/blocker")

function manifest(contentScripts, extra = {}) {
  return parseWebExtensionManifest({
    manifest_version: 2,
    name: "x",
    version: "1",
    browser_specific_settings: { gecko: { id: "x@test" } },
    content_scripts: contentScripts,
    ...extra
  })
}

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

test("content scripts match the frame's URL, frame position, and about:blank rules", () => {
  const spec = (overrides) => ({
    matches: ["https://*.site.test/*"], js: ["a.js"], run_at: "document_start", ...overrides
  })
  const m = manifest([
    spec({}),
    spec({ all_frames: true, exclude_matches: ["https://admin.site.test/*"] }),
    spec({ match_about_blank: true, all_frames: true })
  ])
  const top = { url: "https://www.site.test/x", topUrl: "https://www.site.test/x", isTop: true }
  assert.equal(contentScriptsFor(m, top).length, 3)
  const child = { url: "https://admin.site.test/x", topUrl: "https://www.site.test/x", isTop: false }
  assert.deepEqual(contentScriptsFor(m, child).map((s) => s.matchAboutBlank), [true])
  const blank = { url: "about:blank", topUrl: "https://www.site.test/x", isTop: false }
  assert.deepEqual(contentScriptsFor(m, blank).map((s) => s.matchAboutBlank), [true])
  const elsewhere = { url: "https://other.test/", topUrl: "https://other.test/", isTop: true }
  assert.equal(contentScriptsFor(m, elsewhere).length, 0)
})

test("extension files are read once and never from outside the directory", async () => {
  const extension = await loadUnpackedExtension(fixture, "en")
  const files = new ExtensionFiles(extension)
  assert.match(files.read("background.js"), /onBeforeRequest/)
  assert.equal(files.read("/background.js"), files.read("background.js"))
  assert.throws(() => files.read("../manifest.json"), /outside/)
})

test("only web_accessible_resources are served on the browser session", async () => {
  const extension = {
    ...(await loadUnpackedExtension(fixture, "en")),
    manifest: manifest([], { web_accessible_resources: ["/web_accessible_resources/*", "public.txt"] })
  }
  assert.equal(isWebAccessible(extension, "/web_accessible_resources/noop.js"), true)
  assert.equal(isWebAccessible(extension, "/public.txt"), true)
  assert.equal(isWebAccessible(extension, "/background.js"), false)
  const lookup = () => extension
  const hidden = await serveExtensionRequest(
    extensionUrl(extension.host, "background.js"), lookup, { webAccessibleOnly: true }
  )
  assert.equal(hidden.status, 404)
  const own = await serveExtensionRequest(extensionUrl(extension.host, "background.js"), lookup)
  assert.equal(own.status, 200)
})

test("ports join a content script to the background page and close with it", () => {
  const contexts = new ExtensionContexts()
  const ports = new ExtensionPorts(contexts)
  const background = fakeContext(contexts, "bg", "background")
  const popup = fakeContext(contexts, "popup", "popup")
  const content = fakeContext(contexts, "7:3", "content", 7, 0)
  contexts.addListener("bg", "runtime", "onConnect", 1, null)
  contexts.addListener("popup", "runtime", "onConnect", 2, null)
  contexts.addListener("7:3", "runtime", "onConnect", 3, null)

  const id = ports.connect(content.entry, "vapi", {}, { tab: { id: 7 } })
  assert.equal(typeof id, "number")
  assert.deepEqual(background.sent[0], {
    api: "runtime", event: "onConnect", args: [{ portId: id, name: "vapi", sender: { tab: { id: 7 } } }],
    listeners: [1]
  })
  assert.equal(popup.sent.length, 0)

  ports.post("7:3", id, { hello: 1 })
  assert.deepEqual(background.sent[1], {
    api: "__port", event: "message", args: [{ portId: id, message: { hello: 1 } }]
  })
  ports.post("bg", id, "back")
  assert.deepEqual(content.sent.at(-1).args, [{ portId: id, message: "back" }])
  ports.post("popup", id, "not mine")
  assert.equal(content.sent.length, 1)

  const toTab = ports.connect(popup.entry, "tab", { tabId: 7 }, {})
  assert.equal(content.sent.at(-1).event, "onConnect")
  assert.equal(content.sent.at(-1).args[0].portId, toTab)
  assert.equal(ports.connect(popup.entry, "nobody", { tabId: 99 }, {}), null)

  contexts.remove("7:3")
  assert.deepEqual(background.sent.at(-1), {
    api: "__port", event: "disconnect", args: [{ portId: id }]
  })
  assert.deepEqual(popup.sent.at(-1).args, [{ portId: toTab }])
})
