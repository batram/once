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
const {
  contentScriptsFor, manifestContentScripts, registeredContentScript, ExtensionFiles
} = load("contentScripts")
const { OwnPageRequests, isOwnPage, isWebAccessible, serveExtensionRequest } = load("ExtensionProtocol")
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
  const scripts = manifestContentScripts(m.contentScripts)
  const top = { url: "https://www.site.test/x", topUrl: "https://www.site.test/x", isTop: true }
  assert.equal(contentScriptsFor(scripts, top).length, 3)
  const child = { url: "https://admin.site.test/x", topUrl: "https://www.site.test/x", isTop: false }
  assert.deepEqual(contentScriptsFor(scripts, child).map((s) => s.spec.matchAboutBlank), [true])
  const blank = { url: "about:blank", topUrl: "https://www.site.test/x", isTop: false }
  assert.deepEqual(contentScriptsFor(scripts, blank).map((s) => s.spec.matchAboutBlank), [true])
  const elsewhere = { url: "https://other.test/", topUrl: "https://other.test/", isTop: true }
  assert.equal(contentScriptsFor(scripts, elsewhere).length, 0)
})

test("contentScripts.register requests are validated and keep inline code apart", () => {
  const script = registeredContentScript({
    matches: ["*://*.site.test/*"],
    js: [{ code: "1+1" }, { file: "a.js" }],
    css: [{ code: "body{}" }],
    runAt: "document_start",
    allFrames: true
  })
  assert.deepEqual(script.spec.js, ["a.js"])
  assert.deepEqual(script.inlineJs, ["1+1"])
  assert.deepEqual(script.inlineCss, ["body{}"])
  assert.equal(script.spec.runAt, "document_start")
  assert.equal(script.spec.allFrames, true)
  assert.throws(() => registeredContentScript({ matches: ["nope"], js: [{ code: "1" }] }), /match patterns/)
  assert.throws(() => registeredContentScript({ matches: ["<all_urls>"] }), /js or css/)
  assert.throws(() => registeredContentScript({ matches: ["<all_urls>"], js: [{ code: "1" }], runAt: "now" }), /runAt/)
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

  // A web-accessible page a tab shows is the extension's origin and may load
  // the rest of the extension (uBlock's picker frame loads its scripts so).
  // The webRequest side grants what such a page asks for, once per request;
  // an ordinary page, or a hidden extension page, asking grants nothing.
  const picker = extensionUrl(extension.host, "web_accessible_resources/epicker-ui.html?secret=abc")
  assert.equal(isOwnPage(extension, picker), true)
  assert.equal(isOwnPage(extension, "https://site.test/page"), false)
  assert.equal(isOwnPage(extension, extensionUrl(extension.host, "dashboard.html")), false)
  assert.equal(isOwnPage(extension, extensionUrl("other", "web_accessible_resources/x.html")), false)
  assert.equal(isOwnPage(extension, null), false)
  const ownPages = new OwnPageRequests()
  const script = extensionUrl(extension.host, "background.js")
  const serve = () => serveExtensionRequest(script, lookup, { webAccessibleOnly: true, ownPages })
  assert.equal((await serve()).status, 404)
  ownPages.grant(script)
  assert.equal((await serve()).status, 200)
  assert.equal((await serve()).status, 404)
})

// uBlock's element picker is an extension page in a frame of the tab. It is
// the extension's page (it connects to the background like one), yet it
// comes with the tab and shares the frame's transport with content scripts.
test("an extension's own page inside a tab is a page context tied to the tab", () => {
  const contexts = new ExtensionContexts()
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
