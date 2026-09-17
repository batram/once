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
const { DnrRulesets } = load("DnrRulesets")
const { DnrEnforcer } = load("dnrBridge")
const { WebRequestRouter } = load("WebRequestRouter")
const { ExtensionContexts } = load("ExtensionContexts")
const { loadUnpackedExtension } = load("LoadedExtension")
const api = load("ExtensionApi")
const { DNR_LIMITS } = load("protocol")
const { DnrMatcher } = require("@once/core")

const fixture = path.join(root, "tests/fixtures/extensions/dnr")
const blockerFixture = path.join(root, "tests/fixtures/extensions/blocker")

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function details(url, overrides = {}) {
  return {
    requestId: "1", url, method: "GET", type: "xmlhttprequest", timeStamp: 0, tabId: 5,
    frameId: 0, parentFrameId: -1, documentUrl: "https://site.test/page", frameAncestors: [],
    thirdParty: false, ...overrides
  }
}

test("static rulesets load from the package and enabled sets and dynamic rules persist", async (t) => {
  const dir = tempDir(t, "once-dnr-")
  const file = path.join(dir, "dnr.json")
  const extension = await loadUnpackedExtension(fixture, "en")
  const rulesets = new DnrRulesets(extension, file)
  assert.equal(rulesets.available, true)
  await rulesets.load()
  assert.deepEqual(rulesets.getEnabledRulesets(), ["static"])
  const outcome = (url, type = "xmlhttprequest") => rulesets.matcher().evaluate({ url, type, method: "GET" }).outcome
  assert.equal(outcome("https://site.test/dnr-blocked.txt"), "block")
  assert.equal(outcome("https://site.test/dnr-blocked.txt", "main_frame"), "none")
  assert.equal(outcome("https://site.test/dnr-dormant.txt"), "none")
  assert.equal(rulesets.getAvailableStaticRuleCount(), DNR_LIMITS.GUARANTEED_MINIMUM_STATIC_RULES - 2)

  await rulesets.updateEnabledRulesets({ enableRulesetIds: ["dormant"] })
  assert.deepEqual(rulesets.getEnabledRulesets(), ["static", "dormant"])
  assert.equal(outcome("https://site.test/dnr-dormant.txt"), "block")
  await assert.rejects(rulesets.updateEnabledRulesets({ enableRulesetIds: ["nope"] }), /Invalid ruleset id/)
  await assert.rejects(rulesets.updateEnabledRulesets({ enableRulesetIds: "x" }), /list of strings/)

  await rulesets.updateDynamicRules({ addRules: [
    { id: 7, action: { type: "block" }, condition: { urlFilter: "dynamic-blocked" } }
  ] })
  await assert.rejects(rulesets.updateDynamicRules({ addRules: [
    { id: 7, action: { type: "block" }, condition: { urlFilter: "again" } }
  ] }), /already in use/)
  await assert.rejects(rulesets.updateDynamicRules({ addRules: [{ id: "x" }] }), /addRules\[0\]/)
  rulesets.updateSessionRules({ addRules: [
    { id: 8, action: { type: "block" }, condition: { urlFilter: "session-blocked" } }
  ] })
  // The dynamic and session sets are separate rulesets with their own ids.
  rulesets.updateSessionRules({ addRules: [
    { id: 7, action: { type: "block" }, condition: { urlFilter: "session-seven" } }
  ] })
  assert.deepEqual(rulesets.getDynamicRules().map((rule) => rule.id), [7])
  assert.deepEqual(rulesets.getDynamicRules({ ruleIds: [99] }), [])
  assert.deepEqual(rulesets.getSessionRules().map((rule) => rule.id), [8, 7])
  rulesets.updateSessionRules({ removeRuleIds: [7] })
  assert.equal(outcome("https://site.test/dynamic-blocked"), "block")
  assert.equal(outcome("https://site.test/session-blocked"), "block")
  await rulesets.flush()

  const stored = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.deepEqual(stored.enabledRulesets, ["static", "dormant"])
  assert.equal(stored.dynamicRules.length, 1)

  const reloaded = new DnrRulesets(extension, file)
  await reloaded.load()
  assert.deepEqual(reloaded.getEnabledRulesets(), ["static", "dormant"])
  assert.deepEqual(reloaded.getDynamicRules().map((rule) => rule.id), [7])
  assert.deepEqual(reloaded.getSessionRules(), [], "session rules do not survive a reload")
  await reloaded.updateDynamicRules({ removeRuleIds: [7] })
  await reloaded.flush()
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).dynamicRules, [])

  const blocker = await loadUnpackedExtension(blockerFixture, "en")
  const without = new DnrRulesets(blocker, path.join(dir, "other.json"))
  await without.load()
  assert.equal(without.available, false)
  assert.equal(without.matcher(), null)
})

test("a ruleset that fails to parse is skipped and logged, the rest still loads", async (t) => {
  const dir = tempDir(t, "once-dnr-bad-")
  fs.mkdirSync(path.join(dir, "rules"))
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "Bad", version: "1", browser_specific_settings: { gecko: { id: "bad@once.test" } },
    permissions: ["declarativeNetRequest"],
    declarative_net_request: { rule_resources: [
      { id: "broken", enabled: true, path: "rules/broken.json" },
      { id: "outside", enabled: true, path: "../outside.json" },
      { id: "good", enabled: true, path: "rules/good.json" }
    ] }
  }))
  fs.writeFileSync(path.join(dir, "rules/broken.json"), "[{\"id\": 1}]")
  fs.writeFileSync(path.join(dir, "rules/good.json"), JSON.stringify([
    { id: 1, action: { type: "block" }, condition: { urlFilter: "good" } }
  ]))
  const logged = []
  const original = console.error
  console.error = (...args) => logged.push(args.join(" "))
  try {
    const rulesets = new DnrRulesets(await loadUnpackedExtension(dir, "en"), path.join(dir, "dnr.json"))
    await rulesets.load()
    assert.deepEqual(rulesets.getEnabledRulesets(), ["good"])
    assert.equal(rulesets.matcher().evaluate({ url: "https://a.test/good", type: "script", method: "GET" }).outcome, "block")
  } finally {
    console.error = original
  }
  assert.equal(logged.filter((line) => /ruleset broken was not loaded/.test(line)).length, 1)
  assert.equal(logged.filter((line) => /outside the extension/.test(line)).length, 1)
})

function source(id, rules) {
  const matcher = new DnrMatcher(rules.map((rule) => ({ priority: 1, condition: {}, ...rule })), {
    extensionBaseUrl: `moz-extension://${id}/`
  })
  return { extensionId: id, matcher: () => matcher }
}

test("the enforcer combines extensions: first block wins, then the first redirect; headers stack", () => {
  const first = source("one", [
    { id: 1, action: { type: "redirect", redirect: { url: "https://mirror.test/" } }, condition: { urlFilter: "||slow.test" } },
    { id: 2, action: { type: "modifyHeaders", requestHeaders: [{ header: "X-One", operation: "set", value: "1" }] } },
    { id: 3, action: { type: "allowAllRequests" }, condition: { urlFilter: "||trusted.test", resourceTypes: ["main_frame"] }, priority: 9 },
    { id: 4, action: { type: "block" }, condition: { urlFilter: "||ads.test" } }
  ])
  const second = source("two", [
    { id: 1, action: { type: "block" }, condition: { urlFilter: "||ads.test" } },
    { id: 2, action: { type: "redirect", redirect: { url: "https://other.test/" } }, condition: { urlFilter: "||slow.test" } },
    { id: 3, action: { type: "modifyHeaders", responseHeaders: [{ header: "Set-Cookie", operation: "remove" }],
      requestHeaders: [{ header: "X-Two", operation: "append", value: "2" }] } }
  ])
  const silent = { extensionId: "none", matcher: () => null }
  const enforcer = new DnrEnforcer(() => [silent, first, second])
  assert.deepEqual(enforcer.beforeRequest(details("https://ads.test/x")), { cancel: true })
  assert.deepEqual(enforcer.beforeRequest(details("https://slow.test/x")), { redirectUrl: "https://mirror.test/" })
  assert.deepEqual(enforcer.beforeRequest(details("https://site.test/x")), {})
  assert.deepEqual(
    enforcer.requestHeaders(details("https://site.test/x"), [{ name: "Accept", value: "*/*" }]),
    [{ name: "Accept", value: "*/*" }, { name: "X-One", value: "1" }, { name: "X-Two", value: "2" }]
  )
  assert.deepEqual(
    enforcer.responseHeaders(details("https://site.test/x"), [{ name: "Set-Cookie", value: "a" }, { name: "X", value: "y" }]),
    [{ name: "X", value: "y" }]
  )
  assert.equal(enforcer.responseHeaders(details("https://site.test/x"), [{ name: "X", value: "y" }]), null)

  // A frame allowed by allowAllRequests lets its own requests through for
  // that extension, at that priority, until the tab goes away.
  const frame = details("https://trusted.test/", { type: "main_frame", documentUrl: undefined })
  assert.deepEqual(enforcer.beforeRequest(frame), {})
  const inside = details("https://ads.test/x", { documentUrl: "https://trusted.test/" })
  assert.deepEqual(enforcer.beforeRequest(inside), { cancel: true }, "the second extension still blocks")
  const onlyFirst = new DnrEnforcer(() => [first])
  onlyFirst.beforeRequest(frame)
  assert.deepEqual(onlyFirst.beforeRequest(inside), {})
  assert.deepEqual(onlyFirst.beforeRequest(details("https://ads.test/x", {
    documentUrl: "https://child.test/", frameAncestors: [{ url: "https://trusted.test/", frameId: 0 }]
  })), {}, "requests from a child frame of the allowed page are allowed too")
  assert.deepEqual(onlyFirst.beforeRequest(details("https://ads.test/x", { documentUrl: "https://trusted.test/", tabId: 6 })),
    { cancel: true }, "another tab is not covered")
  onlyFirst.forgetTab(5)
  assert.deepEqual(onlyFirst.beforeRequest(inside), { cancel: true })
})

function fakeSession() {
  const listeners = {}
  const webRequest = {}
  for (const event of [
    "onBeforeRequest", "onBeforeSendHeaders", "onHeadersReceived", "onSendHeaders",
    "onResponseStarted", "onBeforeRedirect", "onCompleted", "onErrorOccurred"
  ]) {
    webRequest[event] = (_filter, listener) => { listeners[event] = listener }
  }
  return { webRequest, listeners }
}

function fakeContents(id) {
  const contents = new EventEmitter()
  contents.id = id
  contents.sent = []
  contents.isDestroyed = () => false
  contents.send = (channel, message) => contents.sent.push({ channel, message })
  contents.getURL = () => `moz-extension://host${id}/page.html`
  return contents
}

test("the router applies declarative rules beside a blocking webRequest listener", async () => {
  const session = fakeSession()
  // A uBlock-like host: one blocking listener that cancels blocked.txt and
  // answers every other request with nothing.
  const contexts = new ExtensionContexts()
  const background = fakeContents(1)
  contexts.add(background, "background")
  contexts.addListener(1, "webRequest", "onBeforeRequest", 10, { filter: { urls: ["<all_urls>"] }, extraInfoSpec: ["blocking"] })
  const seen = []
  background.send = (_channel, message) => {
    seen.push(message.args[0].url)
    contexts.handleReply(1, { token: message.token, result: [message.args[0].url.endsWith("blocked.txt") ? { cancel: true } : {}] })
  }
  const dnr = source("dnr", [
    { id: 1, action: { type: "block" }, condition: { urlFilter: "dnr-blocked" } },
    { id: 2, action: { type: "redirect", redirect: { url: "https://site.test/redirected" } }, condition: { urlFilter: "dnr-redirect" } },
    { id: 3, action: { type: "modifyHeaders", requestHeaders: [{ header: "X-Dnr", operation: "set", value: "yes" }],
      responseHeaders: [{ header: "X-Frame-Options", operation: "remove" }] } }
  ])
  const router = new WebRequestRouter(session, {
    tabIdFor: () => 5,
    sources: () => [{ contexts }],
    declarative: new DnrEnforcer(() => [dnr])
  })
  router.install()
  const electron = (url, extra = {}) => ({
    id: 1, url, method: "GET", resourceType: "xhr", referrer: "", timestamp: 0, webContentsId: 5, frame: null, ...extra
  })
  const run = (event, request) => new Promise((resolve) => session.listeners[event](request, resolve))

  assert.deepEqual(await run("onBeforeRequest", electron("https://site.test/dnr-blocked")), { cancel: true })
  assert.deepEqual(seen, [], "a declarative block never reaches the listener")
  assert.deepEqual(await run("onBeforeRequest", electron("https://site.test/blocked.txt")), { cancel: true })
  assert.deepEqual(seen, ["https://site.test/blocked.txt"], "the webRequest listener still blocks its own")
  assert.deepEqual(await run("onBeforeRequest", electron("https://site.test/dnr-redirect")), {
    redirectURL: "https://site.test/redirected"
  })
  assert.deepEqual(await run("onBeforeRequest", electron("https://site.test/plain")), {})
  assert.deepEqual(
    await run("onBeforeSendHeaders", electron("https://site.test/plain", { requestHeaders: { Accept: "*/*" } })),
    { requestHeaders: { Accept: "*/*", "X-Dnr": "yes" } }
  )
  assert.deepEqual(
    await run("onHeadersReceived", electron("https://site.test/plain", {
      responseHeaders: { "X-Frame-Options": "DENY", "Content-Type": ["text/plain"] }, statusLine: "HTTP/1.1 200", statusCode: 200
    })),
    { responseHeaders: { "Content-Type": "text/plain" } }
  )
})

test("declarativeNetRequest handlers need the permission and say what is unsupported", async (t) => {
  const handlers = api.createApiHandlers()
  const dir = tempDir(t, "once-dnr-api-")
  const extension = await loadUnpackedExtension(fixture, "en")
  const dnr = new DnrRulesets(extension, path.join(dir, "dnr.json"))
  await dnr.load()
  const call = { host: { extension, dnr }, sender: null }
  assert.deepEqual(handlers["declarativeNetRequest.getEnabledRulesets"](call), ["static"])
  await handlers["declarativeNetRequest.updateDynamicRules"](call, { addRules: [
    { id: 1, action: { type: "allow" }, condition: { urlFilter: "x" } }
  ] })
  assert.equal(handlers["declarativeNetRequest.getDynamicRules"](call).length, 1)
  assert.deepEqual(handlers["declarativeNetRequest.isRegexSupported"](call, { regex: "^a(" }),
    { isSupported: false, reason: "syntaxError" })
  assert.throws(() => handlers["declarativeNetRequest.getMatchedRules"](call, {}), /not supported/)
  assert.throws(() => handlers["declarativeNetRequest.testMatchOutcome"](call, {}), /not supported/)

  const blocker = await loadUnpackedExtension(blockerFixture, "en")
  const denied = { host: { extension: blocker, dnr: new DnrRulesets(blocker, path.join(dir, "b.json")) }, sender: null }
  assert.throws(() => handlers["declarativeNetRequest.getEnabledRulesets"](denied), /permission is required/)
  await dnr.flush()
})
