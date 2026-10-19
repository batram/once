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
const { DnrEnforcer, WebRequestRouter } = require("@once/webext-runtime")
const { ElectronExtensionContexts } = load("electronContexts")
const { installWebRequestRouter } = load("electronWebRequest")
const { DnrMatcher } = require("@once/core")

function source(id, rules) {
  const matcher = new DnrMatcher(rules.map((rule) => ({ priority: 1, condition: {}, ...rule })), {
    extensionBaseUrl: `moz-extension://${id}/`
  })
  return { extensionId: id, matcher: () => matcher }
}

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
  const contexts = new ElectronExtensionContexts()
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
  const router = new WebRequestRouter({
    sources: () => [{
      contexts,
      extension: { manifest: { permissions: new Set(["webRequest", "webRequestBlocking"]), hostPermissions: ["<all_urls>"] } }
    }],
    declarative: new DnrEnforcer(() => [dnr])
  })
  installWebRequestRouter(session, router, () => 5)
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

test("webRequest never exposes requests outside the extension's permissions", async () => {
  const session = fakeSession()
  const contexts = new ElectronExtensionContexts()
  const background = fakeContents(9)
  contexts.add(background, "background")
  contexts.addListener(9, "webRequest", "onBeforeRequest", 1,
    { filter: { urls: ["<all_urls>"] }, extraInfoSpec: [] })
  const extension = { manifest: {
    permissions: new Set(), hostPermissions: ["https://allowed.test/*"]
  } }
  installWebRequestRouter(session, new WebRequestRouter({ sources: () => [{ contexts, extension }] }), () => 1)
  const run = (url) => new Promise((resolve) => session.listeners.onBeforeRequest({
    id: 1, url, method: "GET", resourceType: "xhr", referrer: "", timestamp: 0, frame: null
  }, resolve))
  await run("https://allowed.test/a")
  assert.equal(background.sent.length, 0)
  extension.manifest.permissions.add("webRequest")
  await run("https://private.test/a")
  assert.equal(background.sent.length, 0)
  await run("https://allowed.test/a")
  assert.equal(background.sent.length, 1)
})
