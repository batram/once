const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const Module = require("node:module")
const os = require("node:os")
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
const details = load("webRequestDetails")
const scheme = load("ExtensionScheme")
const loaded = load("LoadedExtension")
const extensionProtocol = load("ExtensionProtocol")
const { ExtensionStorage } = load("ExtensionStorage")
const { ExtensionContexts } = load("ExtensionContexts")
const api = load("ExtensionApi")
const { EXTENSION_IPC } = load("protocol")

const fixture = path.join(root, "tests/fixtures/extensions/blocker")

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
  contents.getURL = () => `once-ext://host${id}/page.html`
  return contents
}

test("Electron resource types map onto WebExtension request types", () => {
  assert.equal(details.webExtResourceType("mainFrame"), "main_frame")
  assert.equal(details.webExtResourceType("xhr"), "xmlhttprequest")
  assert.equal(details.webExtResourceType("cspReport"), "csp_report")
  assert.equal(details.webExtResourceType("somethingNew"), "other")
})

test("a sub-resource carries its document, the main frame does not", () => {
  const base = {
    id: 7, method: "GET", referrer: "", timestamp: 1, tabId: 3,
    frame: { frameId: 0, parentFrameId: -1, documentUrl: "https://site.test/page", topUrl: "https://site.test/page" }
  }
  const script = details.buildWebRequestDetails({
    ...base, url: "https://cdn.ads.test/x.js", resourceType: "script",
    requestHeaders: { Accept: "*/*", Cookie: ["a=1", "b=2"] }
  })
  assert.equal(script.requestId, "7")
  assert.equal(script.type, "script")
  assert.equal(script.documentUrl, "https://site.test/page")
  assert.equal(script.originUrl, "https://site.test/page")
  assert.equal(script.thirdParty, true)
  assert.deepEqual(script.requestHeaders, [
    { name: "Accept", value: "*/*" }, { name: "Cookie", value: "a=1" }, { name: "Cookie", value: "b=2" }
  ])

  const main = details.buildWebRequestDetails({
    ...base, url: "https://site.test/next", resourceType: "mainFrame"
  })
  assert.equal(main.documentUrl, null)
  assert.equal(main.frameId, 0)
  assert.equal(main.parentFrameId, -1)
  assert.equal(main.thirdParty, false)
})

test("header conversion round-trips through the WebExtension shape", () => {
  const list = details.headersToWebExt({ "Set-Cookie": ["a", "b"], "X-One": "1" })
  assert.deepEqual(details.headersFromWebExt(list), { "Set-Cookie": ["a", "b"], "X-One": "1" })
})

test("listener filters decide by URL, type, and tab; extraInfoSpec sets capabilities", () => {
  const filter = new details.CompiledRequestFilter({
    filter: { urls: ["*://*.ads.test/*"], types: ["script", "image"], tabId: 3 },
    extraInfoSpec: ["blocking", "requestHeaders"]
  })
  const hit = { url: "https://cdn.ads.test/x.js", type: "script", tabId: 3 }
  assert.equal(filter.matches(hit), true)
  assert.equal(filter.matches({ ...hit, type: "xmlhttprequest" }), false)
  assert.equal(filter.matches({ ...hit, tabId: 4 }), false)
  assert.equal(filter.matches({ ...hit, url: "https://site.test/x.js" }), false)
  assert.equal(filter.blocking, true)
  assert.equal(filter.wantsRequestHeaders, true)
  assert.equal(filter.wantsResponseHeaders, false)
  assert.throws(() => new details.CompiledRequestFilter({ filter: { urls: [] }, extraInfoSpec: [] }))
})

test("blocking responses merge with Firefox precedence", () => {
  const merged = details.mergeBlockingResponses([
    undefined,
    { redirectUrl: "https://first.test/" },
    { requestHeaders: [{ name: "A", value: "1" }] },
    { redirectUrl: "https://second.test/", requestHeaders: [{ name: "B", value: "2" }] },
    { cancel: true },
    "not an object"
  ])
  assert.deepEqual(merged, {
    cancel: true,
    redirectUrl: "https://first.test/",
    requestHeaders: [{ name: "B", value: "2" }]
  })
})

test("extension ids become stable opaque hosts and URLs parse back", () => {
  const host = scheme.hostForExtensionId("uBlock0@raymondhill.net")
  assert.match(host, /^[0-9a-f]{32}$/)
  assert.equal(host, scheme.hostForExtensionId("uBlock0@raymondhill.net"))
  assert.notEqual(host, scheme.hostForExtensionId("other@example.org"))
  const url = scheme.extensionUrl(host, "js/a b.js")
  assert.equal(url, `once-ext://${host}/js/a b.js`)
  assert.deepEqual(scheme.parseExtensionUrl(url), { host, path: "/js/a b.js" })
  assert.deepEqual(scheme.parseExtensionUrl(`once-ext://${host}/x?y#z`), { host, path: "/x" })
  assert.equal(scheme.parseExtensionUrl("https://example.org/"), null)
})

test("an unpacked extension loads with its locale and a generated background page", async () => {
  const extension = await loaded.loadUnpackedExtension(fixture, "de")
  assert.equal(extension.id, "blocker@once.test")
  assert.equal(extension.name, "Once Test Blocker")
  assert.equal(extension.backgroundPage, loaded.GENERATED_BACKGROUND_PAGE)
  assert.equal(extension.manifest.permissions.has("webRequestBlocking"), true)
  assert.deepEqual(extension.manifest.hostPermissions, ["<all_urls>"])
  assert.equal(loaded.resolveExtensionFile(extension, "/../manifest.json"), null)
  assert.equal(loaded.resolveExtensionFile(extension, "/"), null)
  assert.equal(path.basename(loaded.resolveExtensionFile(extension, "background.js")), "background.js")
})

test("the protocol serves extension files, the generated page, and nothing outside", async () => {
  const extension = await loaded.loadUnpackedExtension(fixture, "en")
  const lookup = (host) => (host === extension.host ? extension : undefined)
  const serve = (p) => extensionProtocol.serveExtensionRequest(scheme.extensionUrl(extension.host, p), lookup)

  const page = await serve(loaded.GENERATED_BACKGROUND_PAGE)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<script src="background\.js"><\/script>/)

  const script = await serve("background.js")
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8")
  assert.match(await script.text(), /onBeforeRequest/)

  assert.equal((await serve("../package.json")).status, 404)
  assert.equal((await serve("missing.js")).status, 404)
  assert.equal((await extensionProtocol.serveExtensionRequest("once-ext://nobody/x", lookup)).status, 404)
})

test("storage.local keeps items, reports changes, and survives a reload", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "once-ext-storage-"))
  const file = path.join(dir, "storage.json")
  try {
    const storage = new ExtensionStorage(file)
    assert.deepEqual(await storage.get(null), {})
    assert.deepEqual(await storage.set({ a: 1, b: "two", skipped: undefined }), {
      a: { oldValue: undefined, newValue: 1 },
      b: { oldValue: undefined, newValue: "two" }
    })
    assert.deepEqual(await storage.get("a"), { a: 1 })
    assert.deepEqual(await storage.get(["a", "missing"]), { a: 1 })
    assert.deepEqual(await storage.get({ a: 0, c: "default" }), { a: 1, c: "default" })
    assert.deepEqual(await storage.remove("b"), { b: { oldValue: "two" } })
    await storage.flush()

    const reloaded = new ExtensionStorage(file)
    assert.deepEqual(await reloaded.get(null), { a: 1 })
    assert.equal(await reloaded.getBytesInUse(null) > 0, true)
    assert.deepEqual(await reloaded.clear(), { a: { oldValue: 1 } })
    await reloaded.flush()
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {})
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("contexts route events to the listeners that asked and collect replies", async () => {
  const contexts = new ExtensionContexts()
  const background = fakeContents(1)
  const popup = fakeContents(2)
  contexts.add(background, "background")
  contexts.add(popup, "popup")
  contexts.addListener(1, "webRequest", "onBeforeRequest", 10, {
    filter: { urls: ["<all_urls>"] }, extraInfoSpec: ["blocking"]
  })
  contexts.addListener(1, "runtime", "onMessage", 11, null)

  contexts.emit("runtime", "onMessage", ["hi"], 2)
  assert.equal(popup.sent.length, 0)
  assert.equal(background.sent.length, 1)
  assert.deepEqual(background.sent[0].message, {
    api: "runtime", event: "onMessage", args: ["hi"], listeners: [11]
  })

  const [target] = contexts.targets("webRequest", "onBeforeRequest")
  const pending = contexts.request(target, "webRequest", "onBeforeRequest", [{ url: "x" }], 1000)
  const sent = background.sent[1].message
  assert.equal(typeof sent.token, "number")
  contexts.handleReply(2, { token: sent.token, result: [{ cancel: true }] })
  contexts.handleReply(1, { token: sent.token, result: [{ cancel: true }] })
  assert.deepEqual(await pending, [{ cancel: true }])

  const timedOut = contexts.request(target, "webRequest", "onBeforeRequest", [{}], 5)
  assert.deepEqual(await timedOut, [])

  background.close()
  assert.equal(contexts.targets("runtime", "onMessage").length, 0)
})

test("API handlers answer tabs, messages, i18n, and storage change events", async () => {
  const handlers = api.createApiHandlers()
  const extension = await loaded.loadUnpackedExtension(fixture, "en")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "once-ext-api-"))
  const contexts = new ExtensionContexts()
  const background = fakeContents(1)
  const popup = fakeContents(2)
  contexts.add(background, "background")
  contexts.add(popup, "popup")
  contexts.addListener(1, "runtime", "onMessage", 5, null)
  contexts.addListener(2, "storage", "onChanged", 6, null)
  const tabs = [
    { id: 30, windowId: 1, index: 0, url: "https://a.test/", title: "A", active: false, status: "complete", audible: false, mutedInfo: { muted: false } },
    { id: 31, windowId: 1, index: 1, url: "https://b.test/page", title: "B", active: true, status: "loading", audible: true, mutedInfo: { muted: false } }
  ]
  const host = {
    extension,
    contexts,
    storage: new ExtensionStorage(path.join(dir, "storage.json")),
    hooks: { tabs: () => tabs },
    action: new api.BrowserActionState("Blocker"),
    alarms: new api.AlarmScheduler(() => undefined)
  }
  const call = (sender) => ({ host, sender: contexts.get(sender) })
  try {
    assert.deepEqual(handlers["tabs.query"](call(1), { active: true }).map((tab) => tab.id), [31])
    assert.deepEqual(handlers["tabs.query"](call(1), { url: "*://a.test/*" }).map((tab) => tab.id), [30])
    assert.deepEqual(handlers["tabs.query"](call(1), { audible: true, status: "loading" }).map((tab) => tab.id), [31])
    assert.equal(handlers["tabs.get"](call(1), 30).title, "A")
    assert.throws(() => handlers["tabs.get"](call(1), 99), /Invalid tab ID/)

    assert.equal(handlers["i18n.getMessage"](call(1), "extName"), "Once Test Blocker")
    assert.equal(handlers["i18n.getMessage"](call(1), "nope"), "")
    assert.equal(handlers["management.getSelf"](call(1)).name, "Once Test Blocker")

    handlers["browserAction.setBadgeText"](call(1), { text: "12", tabId: 31 })
    assert.equal(handlers["browserAction.getBadgeText"](call(1), { tabId: 31 }), "12")
    assert.equal(handlers["browserAction.getBadgeText"](call(1), {}), "")
    assert.equal(handlers["browserAction.getTitle"](call(1), {}), "Blocker")

    const reply = handlers["runtime.sendMessage"](call(2), { ping: true })
    const sent = background.sent.find((item) => item.message.event === "onMessage")
    assert.deepEqual(sent.message.args[0], { ping: true })
    assert.equal(sent.message.args[1].id, "blocker@once.test")
    contexts.handleReply(1, { token: sent.message.token, result: [undefined, { pong: true }] })
    assert.deepEqual(await reply, { pong: true })

    await handlers["storage.local.set"](call(1), { key: "value" })
    const change = popup.sent.find((item) => item.channel === EXTENSION_IPC.event)
    assert.deepEqual(change.message.args, [{ key: { oldValue: undefined, newValue: "value" } }, "local"])
    await host.storage.flush()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
