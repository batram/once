// Contexts, the request/reply channel and the API handler table, driven
// through fake context entries: what every host's transport sits behind.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const runtime = require("../../../packages/webext-runtime/dist")
const { NodeJsonStore, loadUnpackedExtension } = require("../../../packages/webext-runtime/dist/node")

const { ExtensionContexts, ExtensionStorage } = runtime
const root = path.resolve(__dirname, "../../..")
const fixture = path.join(root, "tests/fixtures/extensions/blocker")

/** A context whose transport records what it is sent, like a page's IPC would. */
function fakeContext(contexts, id, kind) {
  const sent = []
  let destroyed = false
  const entry = contexts.addEntry({
    id: String(id),
    kind,
    tabId: -1,
    frameId: 0,
    listeners: new Map(),
    url: () => `moz-extension://host${id}/page.html`,
    isDestroyed: () => destroyed,
    send: (message) => sent.push({ message })
  })
  return { entry, sent, close: () => { destroyed = true; contexts.remove(entry.id) } }
}

test("contexts route events to the listeners that asked and collect replies", async () => {
  const contexts = new ExtensionContexts()
  const background = fakeContext(contexts, 1, "background")
  const popup = fakeContext(contexts, 2, "popup")
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

  // Replacing an entry with the same id drops the old document's listeners.
  fakeContext(contexts, 1, "background")
  assert.equal(contexts.targets("runtime", "onMessage").length, 0)
  background.close()
  assert.equal(contexts.get("1"), undefined)
})

test("whenListening resolves once a context registers the event, or gives up", async () => {
  const contexts = new ExtensionContexts()
  fakeContext(contexts, 1, "background")
  await assert.rejects(contexts.whenListening("runtime", "onConnect", 5), /No page listens/)
  const waiting = contexts.whenListening("runtime", "onConnect", 1000)
  contexts.addListener(1, "runtime", "onConnect", 3, null)
  await waiting
})

test("scripting registrations map onto the host's dynamic content scripts", () => {
  const handlers = runtime.createApiHandlers()
  const registered = new Map()
  let next = 1
  const host = {
    extension: { manifest: { permissions: new Set(["scripting"]), hostPermissions: ["<all_urls>"] } },
    registeredScripts: registered,
    registerContentScript(script) {
      const id = next++
      registered.set(id, script)
      return id
    }
  }
  const call = () => ({ host, sender: null })
  const scripts = () => [...registered.values()]
  handlers["scripting.registerContentScripts"](call(), [
    { id: "a", matches: ["https://a.test/*"], js: ["a.js"], runAt: "document_start", world: "MAIN" },
    { id: "b", matches: ["<all_urls>"], css: ["b.css"], allFrames: true }
  ])
  assert.equal(registered.size, 2)
  assert.equal(scripts()[0].spec.world, "MAIN")
  assert.equal(scripts()[0].spec.runAt, "document_start")
  assert.equal(scripts()[1].spec.allFrames, true)
  assert.throws(
    () => handlers["scripting.registerContentScripts"](call(), [{ id: "a", matches: ["<all_urls>"], js: ["x.js"] }]),
    /already registered/
  )
  assert.throws(
    () => handlers["scripting.registerContentScripts"](call(), [
      { id: "c", matches: ["<all_urls>"], js: ["c.js"] },
      { id: "_d", matches: ["<all_urls>"], js: ["d.js"] }
    ]),
    /does not start with/
  )
  assert.equal(registered.size, 2, "a rejected batch registers nothing")
  assert.deepEqual(
    handlers["scripting.getRegisteredContentScripts"](call(), { ids: ["b"] }).map((script) => script.id),
    ["b"]
  )
  handlers["scripting.updateContentScripts"](call(), [{ id: "b", css: ["b2.css"] }])
  assert.equal(registered.size, 2)
  assert.deepEqual(scripts()[1].spec.css, ["b2.css"])
  handlers["scripting.unregisterContentScripts"](call(), { ids: ["a"] })
  assert.deepEqual(handlers["scripting.getRegisteredContentScripts"](call()).map((script) => script.id), ["b"])
  assert.throws(() => handlers["scripting.unregisterContentScripts"](call(), { ids: ["a"] }), /Nonexistent/)
  handlers["scripting.unregisterContentScripts"](call())
  assert.equal(registered.size, 0)
})

test("dynamic scripts require both their API and complete host grants", () => {
  const handlers = runtime.createApiHandlers()
  const host = {
    extension: { manifest: { permissions: new Set(), hostPermissions: ["https://allowed.test/*"] } },
    registeredScripts: new Map(),
    registerContentScript() { throw new Error("should not register") }
  }
  const call = { host, sender: null }
  const script = [{ id: "x", matches: ["https://allowed.test/*"], js: ["x.js"] }]
  assert.throws(() => handlers["scripting.registerContentScripts"](call, script), /scripting permission/)
  host.extension.manifest.permissions.add("scripting")
  assert.throws(() => handlers["scripting.registerContentScripts"](call,
    [{ id: "x", matches: ["<all_urls>"], js: ["x.js"] }]), /host permission/)
  assert.doesNotThrow(() => runtime.requireHostPattern(host.extension, "https://allowed.test/*"))
  assert.throws(() => runtime.requireHostPattern(host.extension, "https://*.allowed.test/*"), /host permission/)
})

test("contentScripts.register needs host grants but no nonexistent API permission", () => {
  const handlers = runtime.createApiHandlers()
  let registered = 0
  const host = {
    extension: { manifest: { permissions: new Set(), hostPermissions: ["https://allowed.test/*"] } },
    registerContentScript() { registered++; return registered }
  }
  const call = { host, sender: null }
  assert.equal(handlers["contentScripts.register"](call,
    { matches: ["https://allowed.test/*"], js: [{ file: "a.js" }] }), 1)
  assert.throws(() => handlers["contentScripts.register"](call,
    { matches: ["<all_urls>"], js: [{ file: "a.js" }] }), /host permission/)
  assert.equal(registered, 1)
})

test("blank frames do not abort authorized all-frame injections", () => {
  const extension = { manifest: { permissions: new Set(), hostPermissions: ["https://allowed.test/*"] } }
  const host = { extension, hooks: { tabs: () => [{ id: 4, url: "https://allowed.test/page" }] } }
  const frames = [
    { url: () => "https://allowed.test/page" },
    { url: () => "about:blank", creatorUrl: () => "https://allowed.test/page" },
    { url: () => "https://other.test/frame" },
    { url: () => "about:blank", creatorUrl: () => "https://other.test/frame" }
  ]
  assert.deepEqual(runtime.authorizedFrames(host, 4, frames), frames.slice(0, 2))
})

test("host patterns are compiled once and domain cookies follow permitted subdomains", () => {
  const extension = { manifest: { hostPermissions: ["https://mail.example.com/*"] } }
  assert.equal(runtime.permittedHosts(extension), runtime.permittedHosts(extension))
  assert.equal(runtime.canAccessCookie(extension,
    { domain: ".example.com", hostOnly: false, secure: true }), true)
  assert.equal(runtime.canAccessCookie(extension,
    { domain: "example.com", hostOnly: true, secure: true }), false)
  assert.equal(runtime.canAccessCookie(extension,
    { domain: ".other.com", hostOnly: false, secure: true }), false)
  const wildcard = { manifest: { hostPermissions: ["*://*.example.com/*"] } }
  assert.equal(runtime.canAccessCookie(wildcard,
    { domain: ".mail.example.com", hostOnly: false, secure: true }), true)
})

test("cookies.get returns a parent-domain cookie for a permitted child host", async () => {
  const extension = { manifest: {
    permissions: new Set(["cookies"]), hostPermissions: ["https://mail.example.com/*"]
  } }
  const cookie = { name: "SID", value: "secret", domain: ".example.com",
    hostOnly: false, secure: true, path: "/" }
  const call = { host: { extension, cookies: { get: async () => [cookie] } }, sender: null }
  const result = await runtime.createApiHandlers()["cookies.get"](call,
    { url: "https://mail.example.com/", name: "SID" })
  assert.equal(result.value, "secret")
})

test("cookies.getAll filters a shared cookie store by permission and host", async () => {
  const handlers = runtime.createApiHandlers()
  const cookies = [
    { name: "allowed", value: "1", domain: "allowed.test", path: "/", secure: true },
    { name: "private", value: "2", domain: "private.test", path: "/", secure: true }
  ]
  const host = {
    extension: { manifest: { permissions: new Set(), hostPermissions: ["https://allowed.test/*"] } },
    cookies: { get: async () => cookies }
  }
  const call = { host, sender: null }
  await assert.rejects(handlers["cookies.getAll"](call, {}), /cookies permission/)
  host.extension.manifest.permissions.add("cookies")
  const result = await handlers["cookies.getAll"](call, {})
  assert.deepEqual(result.map((cookie) => cookie.name), ["allowed"])
  await assert.rejects(handlers["cookies.getAll"](call, { url: "https://private.test/" }), /host permission/)
})

test("a cookie change reaches only extensions permitted to see the cookie", () => {
  const seen = []
  const host = (hostPermissions, permissions) => ({
    extension: { manifest: { permissions: new Set(permissions), hostPermissions } },
    contexts: { emit: (api, event, args) => seen.push({ hostPermissions, api, event, args }) }
  })
  const change = { removed: false, cookie: { domain: ".example.com", hostOnly: false, secure: true }, cause: "explicit" }
  runtime.broadcastCookieChange([
    host(["https://mail.example.com/*"], ["cookies"]),
    host(["https://mail.example.com/*"], []),
    host(["https://other.test/*"], ["cookies"])
  ], change)
  assert.deepEqual(seen.map((item) => item.hostPermissions), [["https://mail.example.com/*"]])
  assert.deepEqual(seen[0].args, [change])
})

test("API calls and listener changes are checked against the surface and the manifest", () => {
  const handlers = { "tabs.query": () => "answered" }
  const contexts = new ExtensionContexts()
  const { entry } = fakeContext(contexts, 1, "background")
  const host = { extension: { manifest: { permissions: new Set(["webRequest"]) } }, contexts }
  assert.equal(runtime.invokeApi(handlers, host, entry, { api: "tabs", method: "query", args: [] }, runtime.EXTENSION_API_SURFACE), "answered")
  assert.throws(() => runtime.invokeApi(handlers, host, entry, { api: "tabs", method: "query", args: [] }, runtime.CONTENT_API_SURFACE), /not available/)
  assert.throws(() => runtime.invokeApi(handlers, host, entry, { api: "tabs", method: "get", args: [] }, runtime.EXTENSION_API_SURFACE), /not implemented/)
  assert.throws(() => runtime.invokeApi(handlers, host, entry, { api: "tabs" }, runtime.EXTENSION_API_SURFACE), /Invalid/)
  assert.equal(runtime.surfaceFor(entry), runtime.EXTENSION_API_SURFACE)
  assert.equal(runtime.surfaceFor({ kind: "content" }), runtime.CONTENT_API_SURFACE)

  runtime.applyListenerChange(host, entry, { action: "add", api: "webRequest", event: "onCompleted", id: 1 }, runtime.EXTENSION_API_SURFACE)
  assert.equal(contexts.targets("webRequest", "onCompleted").length, 1)
  assert.throws(() => runtime.applyListenerChange(host, entry, {
    action: "add", api: "webRequest", event: "onBeforeRequest", id: 2, spec: { filter: {}, extraInfoSpec: ["blocking"] }
  }, runtime.EXTENSION_API_SURFACE), /webRequestBlocking/)
  assert.throws(() => runtime.applyListenerChange(host, entry, { action: "add", api: "nope", event: "x", id: 3 }, runtime.EXTENSION_API_SURFACE), /not available/)
  runtime.applyListenerChange(host, entry, { action: "remove", api: "webRequest", event: "onCompleted", id: 1 }, runtime.EXTENSION_API_SURFACE)
  assert.equal(contexts.targets("webRequest", "onCompleted").length, 0)
})

test("API handlers answer tabs, messages, i18n, platform, and storage change events", async () => {
  const handlers = runtime.createApiHandlers()
  const extension = await loadUnpackedExtension(fixture, "en")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "once-ext-api-"))
  const contexts = new ExtensionContexts()
  const background = fakeContext(contexts, 1, "background")
  const popup = fakeContext(contexts, 2, "popup")
  contexts.addListener(1, "runtime", "onMessage", 5, null)
  contexts.addListener(2, "storage", "onChanged", 6, null)
  const tabs = [
    { id: 30, windowId: 1, index: 0, url: "https://a.test/", title: "A", active: false, status: "complete", audible: false, mutedInfo: { muted: false } },
    { id: 31, windowId: 1, index: 1, url: "https://b.test/page", title: "B", active: true, status: "loading", audible: true, mutedInfo: { muted: false } }
  ]
  const host = {
    extension,
    contexts,
    storage: new ExtensionStorage(new NodeJsonStore(dir), "storage.json"),
    hooks: { tabs: () => tabs, moveTab: async (id, index) => ({ moved: [id, index] }) },
    action: new runtime.BrowserActionState("Blocker"),
    alarms: new runtime.AlarmScheduler(() => undefined),
    platform: { locale: () => "de-DE", os: "android", arch: "arm" }
  }
  const call = (sender) => ({ host, sender: contexts.get(sender) })
  try {
    assert.deepEqual(handlers["tabs.query"](call(1), { active: true }).map((tab) => tab.id), [31])
    assert.deepEqual(handlers["tabs.query"](call(1), { url: "*://a.test/*" }).map((tab) => tab.id), [30])
    assert.deepEqual(handlers["tabs.query"](call(1), { audible: true, status: "loading" }).map((tab) => tab.id), [31])
    assert.equal(handlers["tabs.get"](call(1), 30).title, "A")
    assert.throws(() => handlers["tabs.get"](call(1), 99), /Invalid tab ID/)
    // uBlock moves its own pages after `tabs.update`; -1 means the end.
    assert.deepEqual(await handlers["tabs.move"](call(1), 30, { index: -1 }), { moved: [30, -1] })
    assert.deepEqual(await handlers["tabs.move"](call(1), [30, 31], { index: 0 }), [
      { moved: [30, 0] }, { moved: [31, 0] }
    ])

    assert.equal(handlers["i18n.getMessage"](call(1), "extName"), "Once Test Blocker")
    assert.equal(handlers["i18n.getMessage"](call(1), "nope"), "")
    assert.equal(handlers["i18n.getUILanguage"](call(1)), "de-DE")
    assert.deepEqual(handlers["i18n.getAcceptLanguages"](call(1)), ["de-DE"])
    assert.deepEqual(handlers["runtime.getPlatformInfo"](call(1)), { os: "android", arch: "arm" })
    assert.equal(handlers["management.getSelf"](call(1)).name, "Once Test Blocker")

    handlers["browserAction.setBadgeText"](call(1), { text: "12", tabId: 31 })
    assert.equal(handlers["browserAction.getBadgeText"](call(1), { tabId: 31 }), "12")
    assert.equal(handlers["browserAction.getBadgeText"](call(1), {}), "")
    assert.equal(handlers["browserAction.getTitle"](call(1), {}), "Blocker")
    // Manifest V3 reaches the same button as `action`.
    handlers["action.setBadgeText"](call(1), { text: "3" })
    assert.equal(handlers["browserAction.getBadgeText"](call(1), {}), "3")
    assert.equal(handlers["action.getTitle"](call(1), {}), "Blocker")

    const reply = handlers["runtime.sendMessage"](call(2), { ping: true })
    const sent = background.sent.find((item) => item.message.event === "onMessage")
    assert.deepEqual(sent.message.args[0], { ping: true })
    assert.equal(sent.message.args[1].id, "blocker@once.test")
    contexts.handleReply(1, { token: sent.message.token, result: [undefined, { pong: true }] })
    assert.deepEqual(await reply, { pong: true })

    await handlers["storage.local.set"](call(1), { key: "value" })
    const change = popup.sent.find((item) => item.message.api === "storage")
    assert.deepEqual(change.message.args, [{ key: { oldValue: undefined, newValue: "value" } }, "local"])
    await host.storage.flush()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
