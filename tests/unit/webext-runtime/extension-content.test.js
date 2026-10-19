const assert = require("node:assert/strict")
const path = require("node:path")
const test = require("node:test")
const {
  ExtensionContexts, ExtensionFiles, ExtensionPorts, OwnPageRequests, contentScriptBatches, contentScriptsFor,
  extensionUrl, isOwnPage, isWebAccessible, manifestContentScripts, registeredContentScript, serveExtensionRequest
} = require("../../../packages/webext-runtime/dist")
const { loadUnpackedExtension } = require("../../../packages/webext-runtime/dist/node")
const { parseWebExtensionManifest } = require("../../../packages/core/dist/webext/manifest")

const root = path.resolve(__dirname, "../../..")
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
  assert.throws(() => files.read("missing.js"), /missing/)
})

test("content scripts batch by phase and world with file and inline code", async () => {
  const extension = await loadUnpackedExtension(fixture, "en")
  const host = { extension, files: new ExtensionFiles(extension) }
  const batches = contentScriptBatches(host, [
    { spec: { runAt: "document_start", js: ["background.js"], css: [] }, inlineJs: ["1"], inlineCss: ["b{}"] },
    { spec: { runAt: "document_start", world: "MAIN", js: [], css: [] }, inlineJs: ["2"], inlineCss: [] },
    { spec: { runAt: "document_start", js: [], css: [] }, inlineJs: ["3"], inlineCss: [] }
  ])
  assert.deepEqual(batches.map((batch) => [batch.runAt, batch.world, batch.js.length, batch.css]), [
    ["document_start", undefined, 3, ["b{}"]],
    ["document_start", "MAIN", 1, []]
  ])
  assert.equal(batches[0].js[0].url, extensionUrl(extension.host, "background.js"))
  assert.equal(batches[0].js[1].url, extensionUrl(extension.host, "_registered_content_script.js"))
  assert.deepEqual(batches[0].js.map((script) => script.code).slice(1), ["1", "3"])
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
