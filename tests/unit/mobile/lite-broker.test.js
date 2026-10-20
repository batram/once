// The Lite broker end to end against a fake Java and a fake DevTools: load
// the fixture extension, play its background page over the page channel,
// pause requests at both Fetch stages, register a content world, route
// messages, tabs, storage, DNR, the settings adapters, the Violentmonkey
// hand-off, the catalogue, and an install from an XPI archive.
const assert = require("node:assert/strict")
const path = require("node:path")
const test = require("node:test")
const AdmZip = require("adm-zip")
const { lite, fakeFiles, FakeJava, root } = require("./lite-support")

const { LiteBroker } = lite("broker")
const { worldNonce, selectScripts } = lite("worldBootstrap")
const { WORLD_BINDING } = lite("protocol")
const { syncKey } = lite("liteSync")

const fixture = path.join(root, "tests/unit/mobile/fixtures/lite-extension")
const FIXTURE_ID = "lite-fixture@once.test"
const UBLOCK_ID = "uBlock0@raymondhill.net"
const VIOLENTMONKEY_ID = "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}"
const TOKEN = "0123456789abcdef0123456789abcdef"

function manifestFor(id, name, extra = {}) {
  return JSON.stringify({
    manifest_version: 2, name, version: "1.0", browser_specific_settings: { gecko: { id } },
    background: { scripts: ["background.js"] }, permissions: ["storage", "<all_urls>"], ...extra
  })
}

const memory = {
  "/bundles/ublock": { "manifest.json": manifestFor(UBLOCK_ID, "uBlock Origin"), "background.js": "" },
  "/bundles/violentmonkey": { "manifest.json": manifestFor(VIOLENTMONKEY_ID, "Violentmonkey", { permissions: ["storage", "webRequest", "webRequestBlocking", "<all_urls>"] }), "background.js": "" }
}

async function startBroker(bundled) {
  const files = fakeFiles(memory)
  const java = new FakeJava(files)
  const broker = new LiteBroker(java.port, files)
  const started = java.request("lite.start", { bundled, locale: "en-US", arch: "arm64", token: TOKEN, storageRoot: "/storage" })
  return { java, broker, started: await started, files }
}

function hostOf(broker, id) {
  return broker.hostsLoaded().find((host) => host.extension.id === id)
}

/** Plays the fixture background page: its listeners, as background.js registers them. */
function registerBackground(java, pageId) {
  java.pageMessage(pageId, { type: "listen", change: { action: "add", api: "webRequest", event: "onBeforeRequest", id: 1,
    spec: { filter: { urls: ["*://*/*blocked.png"], types: ["image"] }, extraInfoSpec: ["blocking"] } } })
  java.pageMessage(pageId, { type: "listen", change: { action: "add", api: "runtime", event: "onMessage", id: 2 } })
  java.pageMessage(pageId, { type: "listen", change: { action: "add", api: "tabs", event: "onRemoved", id: 4 } })
  java.pageMessage(pageId, { type: "listen", change: { action: "add", api: "webRequest", event: "onResponseStarted", id: 3,
    spec: { filter: { urls: ["<all_urls>"], types: ["main_frame"] }, extraInfoSpec: ["responseHeaders"] } } })
}

test("the broker loads the bundled fixture, opens its background page and installs its world", async () => {
  const { java, broker, started } = await startBroker([{ id: FIXTURE_ID, directory: fixture, present: true }])
  assert.equal(started.ready, true)
  assert.equal(started.extensions.length, 1)
  const [entry] = started.extensions
  assert.deepEqual(Object.keys(entry).sort(), ["bundled", "description", "disabledReason", "enabled", "hasAction", "hasOptions", "id", "name", "permissions", "version"].sort())
  assert.equal(entry.name, "Once Lite Fixture")
  assert.equal(entry.hasAction, true)
  assert.equal(entry.hasOptions, true)
  const host = hostOf(broker, FIXTURE_ID)
  const background = java.pages.get(host.backgroundPage)
  assert.equal(background.kind, "background")
  assert.equal(background.url, `https://${host.extension.host}.moz-extension.localhost/_generated_background_page.html`)
  assert.match(background.documentStartSource, /^window\.__onceLitePageInit = \{"id":"lite-fixture@once\.test"/)
  assert.ok(background.documentStartSource.endsWith("/* page bootstrap */"))
  assert.equal(java.registrations.length, 1)
  const [registration] = java.registrations
  assert.equal(registration.worldName, `once-ext:${host.extension.host}`)
  assert.equal(registration.binding, WORLD_BINDING)
  assert.ok(registration.source.startsWith("/* world bootstrap */"))
  assert.ok(registration.source.includes("__liteFixtureContent"), "the content script travels in the registration")
  assert.ok(registration.source.includes("outline: 1px solid red"), "and its CSS")
  const config = JSON.parse(/__onceLiteWorldBoot\((.*)\);$/s.exec(registration.source)[1])
  assert.equal(config.token, TOKEN)
  assert.equal(config.init.host, host.extension.host)
  assert.equal(selectScripts(config.scripts, { url: "https://www.site.test/x", topUrl: "https://www.site.test/x", isTop: true }).length, 1)
  assert.equal(selectScripts(config.scripts, { url: "https://other.test/", topUrl: "https://other.test/", isTop: true }).length, 0)
  assert.equal(selectScripts(config.scripts, { url: "https://www.site.test/x", topUrl: "https://www.site.test/", isTop: false }).length, 0, "not all_frames")
  // The catalogue was persisted through the Java store.
  assert.ok(java.stores.has("/storage/manager/installed.json"))
  assert.equal((await java.request("extension.command", { action: "list" })).extensions[0].id, FIXTURE_ID)
})

test("requests pause at both stages: a blocked image, a document with the held onResponseStarted and a nonce", async () => {
  const { java, broker } = await startBroker([{ id: FIXTURE_ID, directory: fixture, present: true }])
  const host = hostOf(broker, FIXTURE_ID)
  const pageId = host.backgroundPage
  registerBackground(java, pageId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(host.contexts.targets("webRequest", "onBeforeRequest").length, 1)

  java.event("tab.changed", { tabId: 7, generation: 1, targetId: "T1", url: "https://site.test/", title: "Site", active: true, index: 0, status: "loading", audible: false, muted: false })
  java.event("target.attached", { targetId: "T1", kind: "tab", tabId: 7, frameTree: { frame: { id: "F1", url: "https://site.test/" } } })

  // An image the fixture blocks.
  java.cdpEvent("T1", "Fetch.requestPaused", { requestId: "R1", networkId: "N1", frameId: "F1", resourceType: "Image",
    request: { url: "https://cdn.test/blocked.png", method: "GET", headers: { Referer: "https://site.test/" } } })
  const blocking = await java.nextPageEvent(pageId, "webRequest", "onBeforeRequest")
  const details = blocking.params.message.message.args[0]
  assert.equal(details.type, "image")
  assert.equal(details.tabId, 7)
  assert.equal(details.frameId, 0)
  assert.equal(details.documentUrl, "https://site.test/")
  java.pageMessage(pageId, { type: "reply", token: blocking.params.message.message.token, result: [{ cancel: true }] })
  const failed = await java.nextCdp("Fetch.failRequest")
  assert.deepEqual(failed.params, { targetId: "T1", method: "Fetch.failRequest", params: { requestId: "R1", errorReason: "BlockedByClient" } })

  // An image nobody blocks continues.
  java.cdpEvent("T1", "Fetch.requestPaused", { requestId: "R2", networkId: "N2", frameId: "F1", resourceType: "Image",
    request: { url: "https://cdn.test/fine.png", method: "GET", headers: {} } })
  const continued = await java.next((e) => e.type === "request" && e.method === "cdp.command" && e.params.params.requestId === "R2")
  assert.equal(continued.params.method, "Fetch.continueRequest")

  // A document: the held onResponseStarted runs before the headers continue, with the nonce added.
  java.cdpEvent("T1", "Fetch.requestPaused", { requestId: "R3", networkId: "N3", frameId: "F1", resourceType: "Document",
    request: { url: "https://site.test/page", method: "GET", headers: {} } })
  await java.next((e) => e.type === "request" && e.method === "cdp.command" && e.params.params.requestId === "R3")
  java.cdpEvent("T1", "Fetch.requestPaused", { requestId: "R3", networkId: "N3", frameId: "F1", resourceType: "Document",
    request: { url: "https://site.test/page", method: "GET", headers: {} }, responseStatusCode: 200, responseStatusText: "OK",
    responseHeaders: [{ name: "Content-Type", value: "text/html" }, { name: "Content-Security-Policy", value: "script-src 'self'" }] })
  const started = await java.nextPageEvent(pageId, "webRequest", "onResponseStarted")
  const startedDetails = started.params.message.message.args[0]
  assert.equal(startedDetails.type, "main_frame")
  assert.equal(startedDetails.statusCode, 200)
  assert.ok(Array.isArray(startedDetails.responseHeaders))
  assert.equal(typeof started.params.message.message.token, "number", "held: main waits for the listener")
  const before = java.cdp.filter((command) => command.params.requestId === "R3" && command.method === "Fetch.continueResponse")
  assert.equal(before.length, 0, "headers are still held")
  java.pageMessage(pageId, { type: "reply", token: started.params.message.message.token, result: [undefined] })
  // A changed policy only takes effect on a fulfilled response: the body is fetched and delivered again.
  const response = await java.nextCdp("Fetch.fulfillWithBody")
  assert.equal(response.params.params.requestId, "R3")
  assert.equal(java.cdp.some((c) => c.method === "Fetch.getResponseBody" && c.params.requestId === "R3"), false, "the body stays off the broker channel")
  assert.equal(response.params.params.body, undefined, "only the headers cross the broker channel")
  const csp = response.params.params.responseHeaders.find((header) => header.name === "Content-Security-Policy")
  const nonce = worldNonce(TOKEN, "https://site.test/page")
  assert.equal(csp.value, `script-src 'self' 'nonce-${nonce}'`)
  assert.equal(response.params.params.responseCode, 200)

  // Completion notifications come from Network events.
  java.cdpEvent("T1", "Network.loadingFinished", { requestId: "N3" })
  java.cdpEvent("T1", "Network.loadingFailed", { requestId: "N2", errorText: "net::ERR_FAILED" })
})

test("a world says hello, sends a runtime message to the background and gets the reply; tabs.query sees Java's tabs", async () => {
  const { java, broker } = await startBroker([{ id: FIXTURE_ID, directory: fixture, present: true }])
  const host = hostOf(broker, FIXTURE_ID)
  const pageId = host.backgroundPage
  registerBackground(java, pageId)
  java.event("tab.changed", { tabId: 7, generation: 1, targetId: "T1", url: "https://site.test/", title: "Site", active: true, index: 0, status: "complete", audible: false, muted: false })
  java.event("tab.changed", { tabId: 8, generation: 1, url: "https://other.test/", title: "Other", active: false, index: 1, status: "complete", audible: true, muted: false })
  java.event("target.attached", { targetId: "T1", kind: "tab", tabId: 7, frameTree: { frame: { id: "F1", url: "https://site.test/" } } })
  java.cdpEvent("T1", "Runtime.executionContextCreated", { context: { id: 1, name: "", auxData: { frameId: "F1", isDefault: true } } })
  java.cdpEvent("T1", "Runtime.executionContextCreated", { context: { id: 5, name: `once-ext:${host.extension.host}`, auxData: { frameId: "F1", isDefault: false } } })
  const hello = { host: host.extension.host, type: "hello", url: "https://site.test/", topUrl: "https://site.test/", creatorUrl: "", matched: true }
  java.cdpEvent("T1", "Runtime.bindingCalled", { name: WORLD_BINDING, payload: JSON.stringify(hello), executionContextId: 5 })
  await new Promise((resolve) => setImmediate(resolve))
  const world = host.contexts.get("world:T1:5")
  assert.equal(world.kind, "content")
  assert.equal(world.tabId, 7)
  assert.equal(world.frameId, 0)
  assert.equal(world.url(), "https://site.test/")

  java.cdpEvent("T1", "Runtime.bindingCalled", { name: WORLD_BINDING, executionContextId: 5,
    payload: JSON.stringify({ host: host.extension.host, type: "invoke", id: 1, api: "runtime", method: "sendMessage", args: ["ping"] }) })
  const message = await java.nextPageEvent(pageId, "runtime", "onMessage")
  const [payload, sender] = message.params.message.message.args
  assert.equal(payload, "ping")
  assert.equal(sender.tab.id, 7)
  assert.equal(sender.url, "https://site.test/")
  java.pageMessage(pageId, { type: "reply", token: message.params.message.message.token, result: [{ echo: "ping" }] })
  const delivered = await java.nextCdp("Runtime.evaluate")
  assert.equal(delivered.params.params.contextId, 5)
  const expression = delivered.params.params.expression
  assert.match(expression, /^__onceLiteDeliver\(/)
  const inner = JSON.parse(JSON.parse(expression.slice("__onceLiteDeliver(".length, -1)))
  assert.deepEqual(inner, { type: "result", id: 1, result: { ok: true, value: { echo: "ping" } } })

  // A page's API call: tabs.query reflects Java's tabs.
  java.pageMessage(pageId, { type: "invoke", id: 9, api: "tabs", method: "query", args: [{}] })
  const result = await java.next((e) => e.type === "request" && e.method === "page.post" && e.params.message.type === "result" && e.params.message.id === 9)
  const tabs = result.params.message.result.value
  assert.deepEqual(tabs.map((tab) => [tab.id, tab.url, tab.active, tab.audible]), [[7, "https://site.test/", true, false], [8, "https://other.test/", false, true]])

  // The active tab stays active while something (a popup, the native menu) covers its view;
  // another tab becoming active takes it over.
  java.event("tab.changed", { tabId: 7, generation: 1, targetId: "T1", url: "https://site.test/", title: "Site", active: false, index: 0, status: "complete", audible: false, muted: false })
  assert.deepEqual(broker.tabs.tabs().map((tab) => [tab.id, tab.active]), [[7, true], [8, false]])
  java.event("tab.changed", { tabId: 8, generation: 1, url: "https://other.test/", title: "Other", active: true, index: 1, status: "complete", audible: true, muted: false })
  assert.deepEqual(broker.tabs.tabs().map((tab) => [tab.id, tab.active]), [[7, false], [8, true]])
  java.event("tab.changed", { tabId: 7, generation: 1, targetId: "T1", url: "https://site.test/", title: "Site", active: true, index: 0, status: "complete", audible: false, muted: false })

  // A world context that goes away is removed.
  java.cdpEvent("T1", "Runtime.executionContextDestroyed", { executionContextId: 5 })
  assert.equal(host.contexts.get("world:T1:5"), undefined)
  java.event("tab.removed", { tabId: 7 })
  const removed = await java.nextPageEvent(pageId, "tabs", "onRemoved")
  assert.deepEqual(removed.params.message.message.args, [7, { windowId: 1, isWindowClosing: false }])
})

test("storage.local round-trips through the Java store and dynamic DNR rules block before any listener", async () => {
  const { java, broker } = await startBroker([{ id: FIXTURE_ID, directory: fixture, present: true }])
  const host = hostOf(broker, FIXTURE_ID)
  const pageId = host.backgroundPage
  const invoke = async (id, api, method, args) => {
    java.pageMessage(pageId, { type: "invoke", id, api, method, args })
    const envelope = await java.next((e) => e.type === "request" && e.method === "page.post" && e.params.message.type === "result" && e.params.message.id === id)
    if (!envelope.params.message.result.ok) throw new Error(envelope.params.message.result.error)
    return envelope.params.message.result.value
  }
  await invoke(1, "storage.local", "set", [{ answer: 42, big: "x".repeat(1000) }])
  assert.deepEqual(await invoke(2, "storage.local", "get", ["answer"]), { answer: 42 })
  await host.storage.flush()
  assert.deepEqual(JSON.parse(java.stores.get(`/storage/${host.extension.host}/storage.json`)), { answer: 42, big: "x".repeat(1000) })
  // Later writes carry only the keys that changed, never the whole document.
  await invoke(10, "storage.local", "set", [{ answer: 43 }])
  await invoke(11, "storage.local", "remove", ["big"])
  await host.storage.flush()
  const patch = java.patches.findLast((entry) => entry.name === "storage.json")
  assert.deepEqual(patch, { name: "storage.json", set: ["answer"], remove: ["big"] })
  assert.deepEqual(JSON.parse(java.stores.get(`/storage/${host.extension.host}/storage.json`)), { answer: 43 })

  await invoke(3, "declarativeNetRequest", "updateDynamicRules", [{ addRules: [
    { id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "||ads.test^", resourceTypes: ["script"] } }
  ] }])
  assert.equal(JSON.parse(java.stores.get(`/storage/${host.extension.host}/dnr.json`)).dynamicRules.length, 1)
  java.event("tab.changed", { tabId: 7, generation: 1, targetId: "T1", url: "https://site.test/", title: "Site", active: true, index: 0, status: "complete", audible: false, muted: false })
  java.event("target.attached", { targetId: "T1", kind: "tab", tabId: 7, frameTree: { frame: { id: "F1", url: "https://site.test/" } } })
  java.cdpEvent("T1", "Fetch.requestPaused", { requestId: "R1", networkId: "N1", frameId: "F1", resourceType: "Script",
    request: { url: "https://ads.test/t.js", method: "GET", headers: {} } })
  const failed = await java.nextCdp("Fetch.failRequest")
  assert.equal(failed.params.params.requestId, "R1")
})

test("applyExtensionSettings hands the lists to uBlock's dashboard port and the hand-off routes through Violentmonkey", async () => {
  const { java, broker } = await startBroker([
    { id: UBLOCK_ID, directory: "/bundles/ublock", present: true },
    { id: VIOLENTMONKEY_ID, directory: "/bundles/violentmonkey", present: true }
  ])
  const ublock = hostOf(broker, UBLOCK_ID)
  const ublockPage = ublock.backgroundPage
  java.pageMessage(ublockPage, { type: "listen", change: { action: "add", api: "runtime", event: "onConnect", id: 1 } })
  const applied = java.request("settings.apply", {
    filterLists: { version: 1, lists: [{ url: "https://lists.test/a.txt", enabled: true }] },
    userscripts: { version: 1, scripts: [] }
  })
  // uBlock's background, played here: the port opens and the dashboard channel answers.
  const connect = await java.next((e) => e.type === "request" && e.method === "page.post" && e.params.pageId === ublockPage &&
    e.params.message.type === "event" && e.params.message.message.event === "onConnect" && e.params.message.message.args[0].name === "once-settings")
  const { portId } = connect.params.message.message.args[0]
  // uBlock's background answers every dashboard port: the settings port, and
  // the broker's readiness checks (`getLists` after start-up and after the reload).
  const dashboard = []
  let answered = 0
  const answerPorts = async () => {
    for (;;) {
      const post = await java.next((e) => e.type === "request" && e.method === "page.post" && e.params.pageId === ublockPage &&
        e.params.message.type === "event" && e.params.message.message.api === "__port" && e.params.message.message.event === "message")
      java.forget(post)
      const { portId: onPort, message: envelope } = post.params.message.message.args[0]
      if (onPort === portId) dashboard.push(envelope.msg.what)
      const reply = envelope.msg.what === "getLists" ? { available: { "easylist": { off: false } } } : {}
      java.pageMessage(ublockPage, { type: "invoke", id: 100 + answered++, api: "__port", method: "post", args: [{ portId: onPort, message: { msgId: envelope.msgId, msg: reply } }] })
    }
  }
  void answerPorts().catch(() => undefined)
  await applied
  assert.deepEqual(dashboard, ["getLists", "applyFilterListSelection", "reloadAllFilters"])
  assert.ok(java.stores.has(`/storage/${ublock.extension.host}/once-filter-lists.json`))

  // Violentmonkey: the relay commands live in the broker, the rest reaches the background.
  const violentmonkey = hostOf(broker, VIOLENTMONKEY_ID)
  const vmPage = violentmonkey.backgroundPage
  assert.deepEqual(await java.request("violentmonkey.send", { cmd: "OnceReadRecords" }), { value: {} })
  await java.request("violentmonkey.send", { cmd: "OnceWriteRecords", data: { a: { id: 1 } } })
  assert.deepEqual(await java.request("violentmonkey.send", { cmd: "OnceReadRecords" }), { value: { a: { id: 1 } } })
  java.pageMessage(vmPage, { type: "listen", change: { action: "add", api: "runtime", event: "onMessage", id: 1 } })
  // Synchronous page mode is turned on before the plugin hears `connected`.
  const options = await java.nextPageEvent(vmPage, "runtime", "onMessage")
  assert.deepEqual(options.params.message.message.args[0], { cmd: "SetOptions", data: { xhrInject: true } })
  java.forget(options)
  java.pageMessage(vmPage, { type: "reply", token: options.params.message.message.token, result: [null] })
  await java.next((e) => e.type === "event" && e.event === "violentmonkey.connected")
  const exported = java.request("violentmonkey.send", { cmd: "ExportZip", data: { values: false } })
  const command = await java.nextPageEvent(vmPage, "runtime", "onMessage")
  assert.deepEqual(command.params.message.message.args[0], { cmd: "ExportZip", data: { values: false } })
  assert.match(command.params.message.message.args[1].url, /^moz-extension:\/\/.*\/_once\/settings$/)
  java.pageMessage(vmPage, { type: "reply", token: command.params.message.message.token, result: [{ items: [] }] })
  assert.deepEqual(await exported, { value: { items: [] } })
  await assert.rejects(java.request("violentmonkey.send", { cmd: "InjectionFeedback" }), /not available/)

  // The hand-off holds tab documents until settled.
  await java.request("violentmonkey.handingOff")
  java.event("tab.changed", { tabId: 7, generation: 1, targetId: "T1", url: "https://site.test/", title: "", active: true, index: 0, status: "loading", audible: false, muted: false })
  java.event("target.attached", { targetId: "T1", kind: "tab", tabId: 7, frameTree: { frame: { id: "F1", url: "about:blank" } } })
  java.cdpEvent("T1", "Fetch.requestPaused", { requestId: "R1", networkId: "N1", frameId: "F1", resourceType: "Document",
    request: { url: "https://site.test/", method: "GET", headers: {} } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(java.cdp.filter((c) => c.params.requestId === "R1").length, 0, "held")
  await java.request("violentmonkey.settled")
  const continued = await java.nextCdp("Fetch.continueRequest")
  assert.equal(continued.params.params.requestId, "R1")
  const unloaded = java.request("extension.command", { action: "enable", id: VIOLENTMONKEY_ID, enabled: false })
  await unloaded
  await assert.rejects(java.request("violentmonkey.send", { cmd: "ExportZip" }), (error) => error.code === "NOT_RUNNING")
})

test("extension pages are served from the package through Fetch and an XPI installs through the Java package host", async () => {
  const { java, broker } = await startBroker([{ id: FIXTURE_ID, directory: fixture, present: true }])
  const host = hostOf(broker, FIXTURE_ID)
  const origin = `https://${host.extension.host}.moz-extension.localhost`
  java.event("target.attached", { targetId: "P1", kind: "page", pageId: host.backgroundPage, frameTree: { frame: { id: "F1", url: "about:blank" } } })
  java.cdpEvent("P1", "Fetch.requestPaused", { requestId: "R1", frameId: "F1", resourceType: "Document",
    request: { url: `${origin}/_generated_background_page.html`, method: "GET", headers: {} } })
  const page = await java.nextCdp("Fetch.fulfillRequest")
  assert.equal(page.params.params.responseCode, 200)
  assert.match(Buffer.from(page.params.params.body, "base64").toString(), /<script src="background\.js"><\/script>/)
  assert.ok(page.params.params.responseHeaders.some((h) => h.name === "content-security-policy"))
  java.cdpEvent("P1", "Page.frameNavigated", { frame: { id: "F1", url: `${origin}/_generated_background_page.html` } })
  java.cdpEvent("P1", "Fetch.requestPaused", { requestId: "R2", frameId: "F1", resourceType: "Script",
    request: { url: `${origin}/background.js`, method: "GET", headers: {} } })
  const script = await java.next((e) => e.type === "request" && e.method === "cdp.command" && e.params.params.requestId === "R2")
  assert.equal(script.params.method, "Fetch.fulfillExtensionAsset")
  assert.equal(script.params.params.directory, fixture)
  assert.equal(script.params.params.path, "background.js")
  assert.equal(script.params.params.body, undefined, "the broker sends no asset bytes")
  // A tab may only load what is web accessible.
  java.event("tab.changed", { tabId: 7, generation: 1, targetId: "T1", url: "https://site.test/", title: "", active: true, index: 0, status: "complete", audible: false, muted: false })
  java.event("target.attached", { targetId: "T1", kind: "tab", tabId: 7, frameTree: { frame: { id: "F2", url: "https://site.test/" } } })
  java.cdpEvent("T1", "Fetch.requestPaused", { requestId: "R3", frameId: "F2", resourceType: "Script",
    request: { url: `${origin}/background.js`, method: "GET", headers: {} } })
  const refused = await java.next((e) => e.type === "request" && e.method === "cdp.command" && e.params.params.requestId === "R3")
  assert.equal(refused.params.params.responseCode, 404)
  java.cdpEvent("T1", "Fetch.requestPaused", { requestId: "R4", frameId: "F2", resourceType: "Image",
    request: { url: `${origin}/assets/icon.png`, method: "GET", headers: {} } })
  const allowed = await java.next((e) => e.type === "request" && e.method === "cdp.command" && e.params.params.requestId === "R4")
  assert.equal(allowed.params.params.responseCode, 200)
  assert.ok(allowed.params.params.responseHeaders.some((h) => h.name === "Access-Control-Allow-Origin"))

  // Install from a picked XPI: Java unzips, the broker validates and writes.
  const zip = new AdmZip()
  zip.addFile("manifest.json", Buffer.from(manifestFor("installed@once.test", "Installed", { permissions: ["tabs"] })))
  zip.addFile("background.js", Buffer.from("// background"))
  java.archives["content://picked.xpi"] = zip.toBuffer()
  const installed = await java.request("extension.command", { action: "chooseFile", file: "content://picked.xpi" })
  const confirm = java.requests.find((e) => e.method === "ui.confirm")
  assert.equal(confirm.params.title, "Install extension")
  assert.match(confirm.params.detail, /• tabs/)
  const entry = installed.extensions.find((e) => e.id === "installed@once.test")
  assert.equal(entry.enabled, true)
  assert.equal(entry.bundled, false)
  assert.ok(hostOf(broker, "installed@once.test"), "loaded after the install")
  assert.equal(Object.keys(java.files.memory).some((directory) => directory.includes("/.staging/")), false, "the unpacked copy is removed")
  const catalog = JSON.parse(java.stores.get("/storage/manager/installed.json"))
  assert.match(catalog["installed@once.test"].directory, /^\/storage\/packages\/[0-9a-f-]{36}$/)
  assert.equal(java.registrations.length, 2)
  // Removal asks first and keeps the data.
  java.confirm = false
  assert.deepEqual(await java.request("extension.command", { action: "remove", id: "installed@once.test" }), { cancelled: true })
  java.confirm = true
  const removed = await java.request("extension.command", { action: "remove", id: "installed@once.test" })
  assert.equal(removed.extensions.some((e) => e.id === "installed@once.test"), false)
  await assert.rejects(java.request("extension.command", { action: "install", source: "https://evil.test/x.xpi" }), (error) => error.code === "INVALID_SOURCE")
  assert.deepEqual(await java.request("extension.command", { action: "options", id: FIXTURE_ID }), { noPage: false })
  assert.equal([...java.pages.values()].some((p) => p.kind === "options" && p.url === `${origin}/options.html`), true)
  assert.deepEqual(await java.request("extension.command", { action: "action", id: FIXTURE_ID }), { noPage: false })
  assert.equal([...java.pages.values()].some((p) => p.kind === "popup"), true)
})

test("scripts registered during a document's held onResponseStarted are served to the world's synchronous request", async () => {
  const { java, broker } = await startBroker([{ id: FIXTURE_ID, directory: fixture, present: true }])
  const host = hostOf(broker, FIXTURE_ID)
  const pageId = host.backgroundPage
  registerBackground(java, pageId)
  java.event("tab.changed", { tabId: 7, generation: 1, targetId: "T1", url: "https://site.test/", title: "", active: true, index: 0, status: "loading", audible: false, muted: false })
  java.event("target.attached", { targetId: "T1", kind: "tab", tabId: 7, frameTree: { frame: { id: "F1", url: "about:blank" } } })
  java.cdpEvent("T1", "Fetch.requestPaused", { requestId: "R1", networkId: "N1", frameId: "F1", resourceType: "Document",
    request: { url: "https://site.test/page", method: "GET", headers: {} } })
  await java.next((e) => e.type === "request" && e.method === "cdp.command" && e.params.params.requestId === "R1")
  java.cdpEvent("T1", "Fetch.requestPaused", { requestId: "R1", networkId: "N1", frameId: "F1", resourceType: "Document",
    request: { url: "https://site.test/page", method: "GET", headers: {} }, responseStatusCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "text/html" }, { name: "Content-Security-Policy", value: "default-src 'self'; connect-src 'none'" }] })
  const started = await java.nextPageEvent(pageId, "webRequest", "onResponseStarted")
  const setsBefore = java.requests.filter((e) => e.method === "worlds.set").length
  // The background registers the document's scriptlet from the listener, as uBlock does, then returns.
  java.pageMessage(pageId, { type: "invoke", id: 50, api: "contentScripts", method: "register", args: [{
    matches: ["https://site.test/*"], js: [{ code: "window.scriptlet = 1" }], runAt: "document_start", world: "MAIN"
  }] })
  await java.next((e) => e.type === "request" && e.method === "page.post" && e.params.message.type === "result" && e.params.message.id === 50)
  java.pageMessage(pageId, { type: "reply", token: started.params.message.message.token, result: [undefined] })
  const continued = await java.next((e) => e.type === "request" && e.method === "cdp.command" && e.params.method === "Fetch.fulfillWithBody" && e.params.params.requestId === "R1")
  const origin = `https://${host.extension.host}.moz-extension.localhost`
  const csp = continued.params.params.responseHeaders.find((h) => h.name === "Content-Security-Policy").value
  assert.ok(csp.includes(`connect-src ${origin}`), `the world's request passes the policy: ${csp}`)
  // No registration was re-installed on the paused target; Java got the answer to serve instead.
  assert.equal(java.requests.filter((e) => e.method === "worlds.set").length, setsBefore)
  const answered = java.requests.filter((e) => e.method === "sync.set")
  assert.equal(answered.length, 1)
  assert.ok(java.requests.indexOf(answered[0]) < java.requests.indexOf(continued), "handed to Java before the document continued")
  // Under the document's key: only its own worlds can name it, and only scripts matching it are in it.
  const key = syncKey(TOKEN, "https://site.test/page")
  const body = JSON.parse(java.syncAnswers.get(`${host.extension.host}/_once/${key}/dynamic?u=${encodeURIComponent("https://site.test/page")}`))
  assert.equal(body.host, host.extension.host)
  assert.equal(body.scripts.length, 1)
  assert.equal(body.scripts[0].world, "MAIN")
  assert.equal(body.scripts[0].js[0].code, "window.scriptlet = 1")

  // A bootstrap that runs again in a live context does not replace the entry.
  java.cdpEvent("T1", "Runtime.executionContextCreated", { context: { id: 5, name: `once-ext:${host.extension.host}`, auxData: { frameId: "F1", isDefault: false } } })
  const hello = JSON.stringify({ host: host.extension.host, type: "hello", url: "https://site.test/page", topUrl: "https://site.test/page", creatorUrl: "", matched: true })
  java.cdpEvent("T1", "Runtime.bindingCalled", { name: WORLD_BINDING, payload: hello, executionContextId: 5 })
  await new Promise((resolve) => setImmediate(resolve))
  const entry = host.contexts.get("world:T1:5")
  host.contexts.addListener(entry.id, "runtime", "onMessage", 1, null)
  java.cdpEvent("T1", "Runtime.bindingCalled", { name: WORLD_BINDING, payload: hello, executionContextId: 5 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(host.contexts.get("world:T1:5"), entry, "the same entry")
  assert.equal(host.contexts.targets("runtime", "onMessage").some((t) => t.entry === entry), true, "listeners kept")
})

test("a blob Violentmonkey names in a document's Set-Cookie is read through its page and handed to Java before the document continues", async () => {
  const { java, broker } = await startBroker([{ id: VIOLENTMONKEY_ID, directory: "/bundles/violentmonkey", present: true }])
  const host = hostOf(broker, VIOLENTMONKEY_ID)
  const pageId = host.backgroundPage
  java.pageMessage(pageId, { type: "listen", change: { action: "add", api: "webRequest", event: "onHeadersReceived", id: 1,
    spec: { filter: { urls: ["*://*/*"], types: ["main_frame", "sub_frame"] }, extraInfoSpec: ["blocking", "responseHeaders"] } } })
  await new Promise((resolve) => setImmediate(resolve))
  java.event("tab.changed", { tabId: 7, generation: 1, targetId: "T1", url: "https://site.test/", title: "", active: true, index: 0, status: "loading", audible: false, muted: false })
  java.event("target.attached", { targetId: "T1", kind: "tab", tabId: 7, frameTree: { frame: { id: "F1", url: "about:blank" } } })
  java.cdpEvent("T1", "Fetch.requestPaused", { requestId: "R1", networkId: "N1", frameId: "F1", resourceType: "Document",
    request: { url: "https://site.test/page", method: "GET", headers: {} }, responseStatusCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html" }] })
  const received = await java.nextPageEvent(pageId, "webRequest", "onHeadersReceived")
  const headers = received.params.message.message.args[0].responseHeaders
  // From the listener, as Violentmonkey does, the content realm's code goes out with tabs.executeScript
  // for a document that does not exist yet; it must run from that document's world at its start.
  java.pageMessage(pageId, { type: "invoke", id: 60, api: "tabs", method: "executeScript", args: [7, { code: "window.vmContent = 1", runAt: "document_start", frameId: 0 }] })
  const executed = await java.next((e) => e.type === "request" && e.method === "page.post" && e.params.message.type === "result" && e.params.message.id === 60)
  assert.deepEqual(executed.params.message.result, { ok: true, value: [null] })
  java.pageMessage(pageId, { type: "reply", token: received.params.message.message.token, result: [{
    responseHeaders: [...headers, { name: "Set-Cookie", value: `${host.extension.host}=4b2c-uuid; SameSite=Lax` }]
  }] })
  // The broker asks the background page for the blob's text.
  const read = await java.nextPageEvent(pageId, "__liteBlob", "read")
  assert.deepEqual(read.params.message.message.args, [{ url: `blob:https://${host.extension.host}.moz-extension.localhost/4b2c-uuid` }])
  java.pageMessage(pageId, { type: "reply", token: read.params.message.message.token, result: ["{\"inject\":true}"] })
  const continued = await java.nextCdp("Fetch.continueResponse")
  assert.ok(continued.params.params.responseHeaders.some((h) => h.name === "Set-Cookie"))
  const key = syncKey(TOKEN, "https://site.test/page")
  const query = `?u=${encodeURIComponent("https://site.test/page")}`
  assert.equal(java.syncAnswers.get(`${host.extension.host}/_once/${key}/blob/4b2c-uuid${query}`), "{\"inject\":true}")
  // The document's own dynamic answer carries the cookie the content script reads the id from.
  const perDocument = JSON.parse(java.syncAnswers.get(`${host.extension.host}/_once/${key}/dynamic${query}`))
  assert.equal(perDocument.cookie, `${host.extension.host}=4b2c-uuid`)
  assert.equal(perDocument.scripts.length, 1, "the queued injection joins the document's answer")
  assert.equal(perDocument.scripts[0].js[0].code, "window.vmContent = 1")
  assert.equal(perDocument.scripts[0].runAt, "document_start")
  const handed = java.requests.find((e) => e.method === "sync.set")
  assert.ok(java.requests.indexOf(handed) < java.requests.indexOf(continued), "handed to Java before the document continued")
})

test("a world speaks for the extension its context belongs to, with the URL DevTools reported for its frame", async () => {
  const { java, broker } = await startBroker([
    { id: FIXTURE_ID, directory: fixture, present: true },
    { id: VIOLENTMONKEY_ID, directory: "/bundles/violentmonkey", present: true }
  ])
  const fixtureHost = hostOf(broker, FIXTURE_ID)
  const vm = hostOf(broker, VIOLENTMONKEY_ID)
  const vmPage = `https://${vm.extension.host}.moz-extension.localhost/options/index.html`
  java.event("tab.changed", { tabId: 7, generation: 1, targetId: "T1", url: "https://site.test/", title: "", active: true, index: 0, status: "complete", audible: false, muted: false })
  java.event("target.attached", { targetId: "T1", kind: "tab", tabId: 7, frameTree: { frame: { id: "F1", url: "https://site.test/" },
    childFrames: [{ frame: { id: "F2", parentId: "F1", url: `https://${vm.extension.host}.moz-extension.localhost/web.html` } }] } })
  java.cdpEvent("T1", "Runtime.executionContextCreated", { context: { id: 5, name: `once-ext:${fixtureHost.extension.host}`, auxData: { frameId: "F1", isDefault: false } } })
  java.cdpEvent("T1", "Runtime.executionContextCreated", { context: { id: 6, name: `once-ext:${vm.extension.host}`, auxData: { frameId: "F1", isDefault: false } } })
  java.cdpEvent("T1", "Runtime.executionContextCreated", { context: { id: 7, name: `once-ext:${vm.extension.host}`, auxData: { frameId: "F2", isDefault: false } } })
  const hello = (contextId, host, url) => java.cdpEvent("T1", "Runtime.bindingCalled", { name: WORLD_BINDING, executionContextId: contextId,
    payload: JSON.stringify({ host, type: "hello", url, topUrl: url, creatorUrl: "", matched: true }) })
  // Code in Violentmonkey's world (a content-mode userscript) claims the fixture's identity: refused.
  hello(6, fixtureHost.extension.host, "https://site.test/")
  // A context that is no extension world at all is refused too.
  hello(9, vm.extension.host, vmPage)
  // Violentmonkey's world claims to be its own page: the frame is a web page, so it is a content script.
  hello(6, vm.extension.host, vmPage)
  // A frame really showing one of its pages is its page inside the tab.
  hello(7, vm.extension.host, "https://site.test/forged")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixtureHost.contexts.get("world:T1:6"), undefined)
  assert.equal(vm.contexts.get("world:T1:9"), undefined)
  const content = vm.contexts.get("world:T1:6")
  assert.equal(content.kind, "content")
  assert.equal(content.url(), "https://site.test/")
  const page = vm.contexts.get("world:T1:7")
  assert.equal(page.kind, "page")
  assert.equal(page.url(), `https://${vm.extension.host}.moz-extension.localhost/web.html`)
  // Calls naming another extension from a registered world go nowhere.
  java.cdpEvent("T1", "Runtime.bindingCalled", { name: WORLD_BINDING, executionContextId: 6,
    payload: JSON.stringify({ host: fixtureHost.extension.host, type: "invoke", id: 1, api: "storage.local", method: "get", args: [null] }) })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(java.cdp.filter((command) => command.method === "Runtime.evaluate" && command.params.contextId === 6).length, 0)
})

test("cookies.onChanged reaches only extensions with the cookies permission and access to the cookie's host", async () => {
  memory["/bundles/narrow"] = { "manifest.json": manifestFor("narrow@once.test", "Narrow", { permissions: ["cookies", "https://a.test/*"] }), "background.js": "" }
  memory["/bundles/wide"] = { "manifest.json": manifestFor("wide@once.test", "Wide", { permissions: ["cookies", "<all_urls>"] }), "background.js": "" }
  const { java, broker } = await startBroker([
    { id: "narrow@once.test", directory: "/bundles/narrow", present: true },
    { id: "wide@once.test", directory: "/bundles/wide", present: true }
  ])
  const narrow = hostOf(broker, "narrow@once.test")
  const wide = hostOf(broker, "wide@once.test")
  for (const host of [narrow, wide]) {
    java.pageMessage(host.backgroundPage, { type: "listen", change: { action: "add", api: "cookies", event: "onChanged", id: 1 } })
  }
  await new Promise((resolve) => setImmediate(resolve))
  java.event("cookies.changed", { removed: false, cookie: { name: "session", value: "1", domain: "b.test", path: "/" }, cause: "explicit" })
  const heard = await java.nextPageEvent(wide.backgroundPage, "cookies", "onChanged")
  assert.equal(heard.params.message.message.args[0].cookie.domain, "b.test")
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(java.sent.some((envelope) => envelope.type === "request" && envelope.method === "page.post" && envelope.params.pageId === narrow.backgroundPage &&
    envelope.params.message.message?.api === "cookies"), false, "a.test only: b.test's cookie stays unseen")
})

test("a stalled renderer: the broker answers Java's ping, continues requests of unknown targets and drops released ones quietly", async () => {
  const { java, broker } = await startBroker([{ id: FIXTURE_ID, directory: fixture, present: true }])
  void broker
  assert.deepEqual(await java.request("broker.ping"), {})
  java.cdpEvent("T9", "Fetch.requestPaused", { requestId: "R1", frameId: "F1", resourceType: "Image", request: { url: "https://cdn.test/a.png", method: "GET", headers: {} } })
  const continued = await java.next((e) => e.type === "request" && e.method === "cdp.command" && e.params.params.requestId === "R1")
  assert.equal(continued.params.method, "Fetch.continueRequest")
  // Java continued a request itself while the broker was blocked; the broker's late answer is refused.
  java.event("target.attached", { targetId: "T1", kind: "tab", tabId: 7, frameTree: { frame: { id: "F1", url: "https://site.test/" } } })
  java.cdpResult = (params) => {
    if (params.params.requestId === "R2") throw Object.assign(new Error("The request was released while the broker was blocked"), { code: "RELEASED" })
    return {}
  }
  java.cdpEvent("T1", "Fetch.requestPaused", { requestId: "R2", networkId: "N2", frameId: "F1", resourceType: "Image", request: { url: "https://cdn.test/b.png", method: "GET", headers: {} } })
  await java.next((e) => e.type === "request" && e.method === "cdp.command" && e.params.params.requestId === "R2")
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(java.cdp.filter((command) => command.params.requestId === "R2").length, 1, "not retried")
  assert.equal(java.events.some((e) => e.event === "log" && /failed in the broker/.test(e.params.message)), false)
})

test("a document's answer holds only the registered scripts that match it", async () => {
  const { java, broker } = await startBroker([{ id: FIXTURE_ID, directory: fixture, present: true }])
  const host = hostOf(broker, FIXTURE_ID)
  host.registerContentScript({ spec: { matches: ["https://site.test/*"], excludeMatches: [], js: [], css: [], allFrames: false, matchAboutBlank: false, runAt: "document_start" },
    inlineJs: ["window.mine = 1"], inlineCss: [] })
  java.event("target.attached", { targetId: "T1", kind: "tab", tabId: 7, frameTree: { frame: { id: "F1", url: "about:blank" } } })
  const load = async (requestId, url) => {
    java.cdpEvent("T1", "Fetch.requestPaused", { requestId, networkId: requestId, frameId: "F1", resourceType: "Document",
      request: { url, method: "GET", headers: {} }, responseStatusCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html" }] })
    await java.next((e) => e.type === "request" && e.method === "cdp.command" && e.params.params.requestId === requestId &&
      e.params.method !== "Fetch.getResponseBody")
  }
  await load("R1", "https://other.test/")
  assert.equal([...java.syncAnswers.keys()].length, 0, "nothing for a document no script matches")
  await load("R2", "https://site.test/a")
  const [path] = [...java.syncAnswers.keys()]
  assert.equal(path, `${host.extension.host}/_once/${syncKey(TOKEN, "https://site.test/a")}/dynamic?u=${encodeURIComponent("https://site.test/a")}`)
  assert.equal(JSON.parse(java.syncAnswers.get(path)).scripts[0].js[0].code, "window.mine = 1")
})

test("a same-document navigation keeps the frame's world contexts and the main world they evaluate in", async () => {
  const { java, broker } = await startBroker([{ id: FIXTURE_ID, directory: fixture, present: true }])
  const host = hostOf(broker, FIXTURE_ID)
  java.event("target.attached", { targetId: "T1", kind: "tab", tabId: 7, frameTree: { frame: { id: "F1", url: "https://site.test/" },
    childFrames: [{ frame: { id: "F2", parentId: "F1", url: "https://site.test/frame" } }] } })
  java.cdpEvent("T1", "Runtime.executionContextCreated", { context: { id: 3, name: "", auxData: { frameId: "F2", isDefault: true } } })
  java.cdpEvent("T1", "Runtime.executionContextCreated", { context: { id: 5, name: `once-ext:${host.extension.host}`, auxData: { frameId: "F2", isDefault: false } } })
  java.cdpEvent("T1", "Runtime.bindingCalled", { name: WORLD_BINDING, executionContextId: 5,
    payload: JSON.stringify({ host: host.extension.host, type: "hello", url: "https://site.test/frame", topUrl: "", creatorUrl: "", matched: true }) })
  await new Promise((resolve) => setImmediate(resolve))
  java.cdpEvent("T1", "Page.navigatedWithinDocument", { frameId: "F2", url: "https://site.test/frame#step2" })
  assert.deepEqual(broker.worldContexts("T1").map((world) => world.contextId), [5])
  // Its later destruction still finds the entry: nothing leaks.
  java.cdpEvent("T1", "Runtime.bindingCalled", { name: WORLD_BINDING, executionContextId: 5,
    payload: JSON.stringify({ host: host.extension.host, type: "main-eval", code: "1" }) })
  const evaluated = await java.nextCdp("Runtime.evaluate")
  assert.equal(evaluated.params.params.contextId, 3, "in the subframe's main world, not the top frame's")
  java.cdpEvent("T1", "Runtime.executionContextDestroyed", { executionContextId: 5 })
  assert.equal(host.contexts.get("world:T1:5"), undefined)
})

test("an extension's own pages are decided per request: a navigation in a tab, a web frame in its page, no grant left behind", async () => {
  const { java, broker } = await startBroker([{ id: FIXTURE_ID, directory: fixture, present: true }])
  const host = hostOf(broker, FIXTURE_ID)
  const origin = `https://${host.extension.host}.moz-extension.localhost`
  const status = async (targetId, requestId, frameId, url, resourceType) => {
    java.cdpEvent(targetId, "Fetch.requestPaused", { requestId, frameId, resourceType, request: { url, method: "GET", headers: {} } })
    const answer = await java.next((e) => e.type === "request" && e.method === "cdp.command" && e.params.params.requestId === requestId)
    return answer.params.params.responseCode
  }
  // A tab showing the fixture's web-accessible picker in a frame (F2), and a web frame (F3) beside it.
  java.event("target.attached", { targetId: "T1", kind: "tab", tabId: 7, frameTree: { frame: { id: "F1", url: "https://evil.test/" }, childFrames: [
    { frame: { id: "F2", parentId: "F1", url: `${origin}/picker.html` } }, { frame: { id: "F3", parentId: "F1", url: "https://evil.test/x" } }
  ] } })
  assert.equal(await status("T1", "R1", "F2", `${origin}/background.js`, "Script"), 200, "the picker loads its extension's files")
  assert.equal(await status("T1", "R2", "F3", `${origin}/background.js`, "Script"), 404, "a web frame does not, and no grant was left for it")
  assert.equal(await status("T1", "R3", "F2", `${origin}/options.html`, "Document"), 404, "the page around the picker cannot navigate it to a private page")
  assert.equal(await status("T1", "R4", "F2", `${origin}/picker.html`, "Document"), 200)
  // The extension's options page WebView with a web frame in it.
  java.event("target.attached", { targetId: "P1", kind: "page", pageId: host.backgroundPage, frameTree: { frame: { id: "G1", url: `${origin}/options.html` },
    childFrames: [{ frame: { id: "G2", parentId: "G1", url: "https://web.test/" } }] } })
  assert.equal(await status("P1", "R5", "G1", `${origin}/background.js`, "Script"), 200)
  assert.equal(await status("P1", "R6", "G2", `${origin}/background.js`, "Script"), 404, "a web frame inside the extension's page")
  assert.equal(await status("P1", "R7", "G1", `${origin}/popup.html`, "Document"), 200, "the page's own top frame")
})

test("contexts coming and going leave no removal listener behind", async () => {
  const { broker } = await startBroker([{ id: FIXTURE_ID, directory: fixture, present: true }])
  const host = hostOf(broker, FIXTURE_ID)
  const listeners = () => host.contexts.removed.size
  const before = listeners()
  for (let index = 0; index < 500; index++) {
    const entry = host.contexts.addWorld({ targetId: "T1", contextId: index, tabId: 7, frameId: 0, url: () => "https://site.test/", creatorUrl: () => "" })
    host.contexts.remove(entry.id)
    assert.equal(entry.isDestroyed(), true)
    assert.equal(entry.url(), "")
  }
  assert.equal(listeners(), before)
})

test("extension frames inside a tab: each extension's own, answered through the tab, gone with its view", async () => {
  const { java, broker } = await startBroker([
    { id: FIXTURE_ID, directory: fixture, present: true },
    { id: VIOLENTMONKEY_ID, directory: "/bundles/violentmonkey", present: true }
  ])
  const fixtureHost = hostOf(broker, FIXTURE_ID)
  const vm = hostOf(broker, VIOLENTMONKEY_ID)
  const frameMessage = (frameId, host, message) => java.event("page.message", { pageId: "tab:7", frameId, mainFrame: false,
    url: `https://${host.extension.host}.moz-extension.localhost/`, message: { ...message, href: `https://${host.extension.host}.moz-extension.localhost/picker.html` } })
  // A page framing the fixture's picker first does not keep Violentmonkey's frame out.
  frameMessage(1, fixtureHost, { type: "listen", change: { action: "add", api: "runtime", event: "onMessage", id: 1 } })
  frameMessage(2, vm, { type: "invoke", id: 5, api: "runtime", method: "getPlatformInfo", args: [] })
  const answer = await java.next((e) => e.type === "request" && e.method === "page.post" && e.params.pageId === "tab:7" && e.params.message.type === "result")
  assert.equal(answer.params.frameId, 2)
  assert.equal(answer.params.message.result.ok, true)
  assert.ok(fixtureHost.contexts.get("page:tab:7:1"))
  assert.ok(vm.contexts.get("page:tab:7:2"))
  assert.equal(java.events.some((e) => e.event === "log" && /Untrusted/.test(e.params.message)), false)
  // The tab's view was replaced: both frames are gone.
  java.event("page.closed", { pageId: "tab:7" })
  assert.equal(fixtureHost.contexts.get("page:tab:7:1"), undefined)
  assert.equal(vm.contexts.get("page:tab:7:2"), undefined)
})

test("documents wait for Violentmonkey's late cookie only when it has scripts to inject", async () => {
  const { java, broker } = await startBroker([{ id: VIOLENTMONKEY_ID, directory: "/bundles/violentmonkey", present: true }])
  const host = hostOf(broker, VIOLENTMONKEY_ID)
  const pageId = host.backgroundPage
  java.pageMessage(pageId, { type: "listen", change: { action: "add", api: "webRequest", event: "onHeadersReceived", id: 1,
    spec: { filter: { urls: ["*://*/*"], types: ["main_frame", "sub_frame"] }, extraInfoSpec: ["blocking", "responseHeaders"] } } })
  await host.storage.get(null)
  java.event("target.attached", { targetId: "T1", kind: "tab", tabId: 7, frameTree: { frame: { id: "F1", url: "about:blank" } } })
  let asked = 0
  const answerAll = (async () => {
    for (;;) {
      const ask = await java.nextPageEvent(pageId, "webRequest", "onHeadersReceived").catch(() => null)
      if (!ask) return
      java.forget(ask)
      asked += 1
      java.pageMessage(pageId, { type: "reply", token: ask.params.message.message.token, result: [undefined] })
    }
  })()
  const load = async (requestId) => {
    java.cdpEvent("T1", "Fetch.requestPaused", { requestId, networkId: requestId, frameId: "F1", resourceType: "Document",
      request: { url: "https://site.test/", method: "GET", headers: {} }, responseStatusCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html" }] })
    await java.next((e) => e.type === "request" && e.method === "cdp.command" && e.params.params.requestId === requestId, 5000)
  }
  await load("R1")
  assert.equal(asked, 1, "no scripts: asked once, no retries")
  await host.storage.set({ "scr:1": { config: { enabled: 1 } } })
  await load("R2")
  assert.equal(asked, 6, "with scripts: asked again while its preparation may still be running")
  await answerAll
})

test("extension hosts are random per install, kept across starts, and an install from before keeps its host", async () => {
  const { hostForExtensionId } = require("@once/webext-runtime")
  const bundled = [{ id: FIXTURE_ID, directory: fixture, present: true }]
  const start = async (files, stores) => {
    const java = new FakeJava(files)
    if (stores) java.stores = stores
    const broker = new LiteBroker(java.port, files)
    await java.request("lite.start", { bundled, locale: "en-US", arch: "arm64", token: TOKEN, storageRoot: "/storage" })
    return { java, host: hostOf(broker, FIXTURE_ID).extension.host }
  }
  const files = fakeFiles({ ...memory })
  const first = await start(files)
  assert.match(first.host, /^[0-9a-f]{32}$/)
  assert.notEqual(first.host, hostForExtensionId(FIXTURE_ID), "not the host every install would share")
  assert.ok(first.java.registrations[0].worldName.endsWith(first.host))
  const again = await start(files, first.java.stores)
  assert.equal(again.host, first.host, "kept across starts")
  // An install from before this change: its data lives under the derived host, which it keeps.
  const upgraded = await start(fakeFiles({ ...memory, [`/storage/${hostForExtensionId(FIXTURE_ID)}`]: { "storage.json": "{}" } }))
  assert.equal(upgraded.host, hostForExtensionId(FIXTURE_ID))
})

test("a detached target leaves no request records or ids behind", async () => {
  const { java, broker } = await startBroker([{ id: FIXTURE_ID, directory: fixture, present: true }])
  java.event("target.attached", { targetId: "T1", kind: "tab", tabId: 7, frameTree: { frame: { id: "F1", url: "https://site.test/" } } })
  java.cdpEvent("T1", "Fetch.requestPaused", { requestId: "R1", networkId: "N1", frameId: "F1", resourceType: "Image", request: { url: "https://cdn.test/a.png", method: "GET", headers: {} } })
  await java.next((e) => e.type === "request" && e.method === "cdp.command" && e.params.params.requestId === "R1")
  assert.equal(broker.webRequest.ids.size, 1)
  java.event("target.detached", { targetId: "T1" })
  assert.equal(broker.webRequest.ids.size, 0)
  assert.equal(broker.webRequest.records.size, 0)
})

test("a world whose context Chromium reports before the frame's navigation is still the extension's", async () => {
  const { java, broker } = await startBroker([{ id: FIXTURE_ID, directory: fixture, present: true }])
  const host = hostOf(broker, FIXTURE_ID)
  java.event("target.attached", { targetId: "T1", kind: "tab", tabId: 7, frameTree: { frame: { id: "F1", url: "about:blank" } } })
  java.cdpEvent("T1", "Runtime.executionContextsCleared", {})
  java.cdpEvent("T1", "Runtime.executionContextCreated", { context: { id: 8, name: `once-ext:${host.extension.host}`, auxData: { frameId: "F1", isDefault: false } } })
  java.cdpEvent("T1", "Page.frameNavigated", { frame: { id: "F1", url: "https://site.test/" } })
  java.cdpEvent("T1", "Runtime.bindingCalled", { name: WORLD_BINDING, executionContextId: 8,
    payload: JSON.stringify({ host: host.extension.host, type: "hello", url: "https://site.test/", topUrl: "https://site.test/", creatorUrl: "", matched: true }) })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(host.contexts.get("world:T1:8")?.url(), "https://site.test/")
  assert.deepEqual(broker.worldContexts("T1").map((world) => world.contextId), [8])
})

test("a paused document does not bypass injection host permissions", async () => {
  const files = fakeFiles({ "/no-host": {
    "manifest.json": manifestFor("no-host@once.test", "No host grants", { permissions: ["storage"] }), "background.js": ""
  } })
  const java = new FakeJava(files)
  const broker = new LiteBroker(java.port, files)
  await java.request("lite.start", { bundled: [{ id: "no-host@once.test", directory: "/no-host", present: true }], locale: "en", arch: "arm64", token: TOKEN, storageRoot: "/storage" })
  const host = broker.hostsLoaded()[0]
  java.event("tab.changed", { tabId: 7, generation: 1, url: "https://bank.test/", active: true, index: 0 })
  java.event("target.attached", { targetId: "T", kind: "tab", tabId: 7, frameTree: { frame: { id: "F", url: "https://bank.test/" } } })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const original = broker.webRequest.options.router.headersReceived.bind(broker.webRequest.options.router)
  broker.webRequest.options.router.headersReceived = async (input) => { await gate; return original(input) }
  java.cdpEvent("T", "Fetch.requestPaused", { requestId: "R", networkId: "N", frameId: "F", resourceType: "Document",
    request: { url: "https://bank.test/", method: "GET", headers: {} }, responseStatusCode: 200, responseHeaders: [] })
  java.pageMessage(host.backgroundPage, { type: "invoke", id: 1, api: "tabs", method: "executeScript", args: [7, { code: "window.stolen = document.body.innerText", runAt: "document_start" }] })
  const result = await java.next((e) => e.method === "page.post" && e.params.message.id === 1)
  assert.equal(result.params.message.result.ok, false)
  assert.match(result.params.message.result.error, /host permission/)
  release()
  await java.nextCdp("Fetch.continueResponse")
  assert.equal(java.requests.filter((e) => e.method === "sync.set").length, 0)
})

test("detaching a frame retires its worlds and descendants before context-destroyed arrives", async () => {
  const { java, broker } = await startBroker([{ id: FIXTURE_ID, directory: fixture, present: true }])
  const host = hostOf(broker, FIXTURE_ID)
  java.event("target.attached", { targetId: "T", kind: "tab", tabId: 7, frameTree: { frame: { id: "F", url: "https://site.test/" } } })
  for (const [frameId, parentId, contextId] of [["CH", "F", 6], ["GRAND", "CH", 7]]) {
    java.cdpEvent("T", "Page.frameNavigated", { frame: { id: frameId, parentId, url: "https://site.test/" } })
    java.cdpEvent("T", "Runtime.executionContextCreated", { context: { id: contextId, name: `once-ext:${host.extension.host}`, auxData: { frameId, isDefault: false } } })
    java.cdpEvent("T", "Runtime.bindingCalled", { name: WORLD_BINDING, executionContextId: contextId, payload: JSON.stringify({ host: host.extension.host, type: "hello" }) })
    assert.ok(host.contexts.get(`world:T:${contextId}`))
  }
  java.cdpEvent("T", "Page.frameDetached", { frameId: "CH" })
  for (const contextId of [6, 7]) {
    assert.equal(host.contexts.get(`world:T:${contextId}`), undefined)
    java.cdpEvent("T", "Runtime.executionContextDestroyed", { executionContextId: contextId })
  }
  assert.equal(broker.worldContexts("T").length, 0)
})

test("page document retirement removes listeners and does not receive the next document's replies", async () => {
  const { java, broker } = await startBroker([{ id: FIXTURE_ID, directory: fixture, present: true }])
  const host = hostOf(broker, FIXTURE_ID)
  const pageId = host.backgroundPage
  registerBackground(java, pageId)
  assert.ok(host.contexts.get(`page:${pageId}:0`))
  java.event("page.frameGone", { pageId, frameId: 0 })
  assert.equal(host.contexts.get(`page:${pageId}:0`), undefined)
  assert.equal(host.contexts.targets("webRequest", "onBeforeRequest").length, 0)
  java.pageMessage(pageId, { type: "invoke", id: 1, api: "storage", method: "local.get", args: [null] }, { frameId: 7 })
  const response = await java.next((e) => e.method === "page.post" && e.params.message.id === 1)
  assert.equal(response.params.frameId, 7)
  assert.ok(host.contexts.get(`page:${pageId}:7`))
})

test("a queued injection loses an activeTab grant before its document is prepared", async () => {
  const files = fakeFiles({ "/active-tab": {
    "manifest.json": manifestFor("active-tab@once.test", "Active tab only", { permissions: ["activeTab"] }), "background.js": ""
  } })
  const java = new FakeJava(files)
  const broker = new LiteBroker(java.port, files)
  await java.request("lite.start", { bundled: [{ id: "active-tab@once.test", directory: "/active-tab", present: true }], locale: "en", arch: "arm64", token: TOKEN, storageRoot: "/storage" })
  const host = broker.hostsLoaded()[0]
  java.event("tab.changed", { tabId: 7, generation: 1, url: "https://site.test/", active: true, index: 0 })
  java.event("target.attached", { targetId: "T", kind: "tab", tabId: 7, frameTree: { frame: { id: "F", url: "https://site.test/" } } })
  host.grantActiveTab(host.hooks.tabs()[0])
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const original = broker.webRequest.options.router.headersReceived.bind(broker.webRequest.options.router)
  broker.webRequest.options.router.headersReceived = async (input) => { await gate; return original(input) }
  java.cdpEvent("T", "Fetch.requestPaused", { requestId: "R", networkId: "N", frameId: "F", resourceType: "Document",
    request: { url: "https://site.test/next", method: "GET", headers: {} }, responseStatusCode: 200, responseHeaders: [] })
  java.pageMessage(host.backgroundPage, { type: "invoke", id: 1, api: "tabs", method: "executeScript", args: [7, { code: "window.probe = 1", runAt: "document_start" }] })
  const result = await java.next((e) => e.method === "page.post" && e.params.message.id === 1)
  assert.equal(result.params.message.result.ok, true)
  host.revokeActiveTab(7)
  release()
  await java.nextCdp("Fetch.continueResponse")
  assert.equal(java.requests.filter((e) => e.method === "sync.set").length, 0, "revoked authority cannot reach the next document")
})

test("initial restore registers both extensions once and later loads still update worlds", async () => {
  const files = fakeFiles({ "/first": { "manifest.json": manifestFor("first@test", "First"), "background.js": "" }, "/second": { "manifest.json": manifestFor("second@test", "Second"), "background.js": "" } })
  const java = new FakeJava(files)
  const broker = new LiteBroker(java.port, files)
  await java.request("lite.start", { bundled: [
    { id: "second@test", directory: "/second", present: true },
    { id: "first@test", directory: "/first", present: true }
  ], locale: "en", arch: "arm64", token: TOKEN, storageRoot: "/storage" })
  assert.equal(java.requests.filter(e => e.method === "worlds.set").length, 1)
  assert.equal(java.registrations.length, 2)
  await broker.load(fixture, FIXTURE_ID)
  assert.equal(java.requests.filter(e => e.method === "worlds.set").length, 2)
  assert.equal(java.registrations.length, 3)
})
