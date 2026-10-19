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
  "/bundles/violentmonkey": { "manifest.json": manifestFor(VIOLENTMONKEY_ID, "Violentmonkey"), "background.js": "" }
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
  const response = await java.nextCdp("Fetch.continueResponse")
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
  await invoke(1, "storage.local", "set", [{ answer: 42 }])
  assert.deepEqual(await invoke(2, "storage.local", "get", ["answer"]), { answer: 42 })
  await host.storage.flush()
  assert.equal(java.stores.get(`/storage/${host.extension.host}/storage.json`), JSON.stringify({ answer: 42 }))

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
  const connect = await java.nextPageEvent(ublockPage, "runtime", "onConnect")
  const { portId, name } = connect.params.message.message.args[0]
  assert.equal(name, "once-settings")
  const dashboard = []
  for (;;) {
    const post = await java.next((e) => e.type === "request" && e.method === "page.post" && e.params.pageId === ublockPage &&
      e.params.message.type === "event" && e.params.message.message.api === "__port" && e.params.message.message.event === "message")
    java.forget(post)
    const envelope = post.params.message.message.args[0].message
    dashboard.push(envelope.msg.what)
    const reply = envelope.msg.what === "getLists" ? { available: { "easylist": { off: false } } } : {}
    java.pageMessage(ublockPage, { type: "invoke", id: 100 + dashboard.length, api: "__port", method: "post", args: [{ portId, message: { msgId: envelope.msgId, msg: reply } }] })
    if (envelope.msg.what === "reloadAllFilters") break
  }
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
  java.cdpEvent("P1", "Fetch.requestPaused", { requestId: "R2", frameId: "F1", resourceType: "Script",
    request: { url: `${origin}/background.js`, method: "GET", headers: {} } })
  const script = await java.next((e) => e.type === "request" && e.method === "cdp.command" && e.params.params.requestId === "R2")
  assert.equal(script.params.method, "Fetch.fulfillRequest")
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
