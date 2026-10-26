const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const { parseHTML } = require("linkedom")

const settle = () => new Promise(resolve => setImmediate(resolve))
const amo = require("@once/webext-runtime/amo")

/**
 * The iOS page script against a linkedom document at `origin`, with a
 * recording native handler. The shim and the bridge read the page's globals
 * from the real global object (in a page that is `window`), so the harness
 * stages everything on `globalThis` and passes it as the scope.
 */
function harness(origin, { reply = async () => null, handler = true } = {}) {
  const { document } = parseHTML("<html><head></head><body></body></html>")
  const posts = []
  const location = new URL(origin + "/en-US/firefox/addon/consent-o-matic/")
  const window = globalThis
  const define = (name, value) => Object.defineProperty(window, name, { value, configurable: true, writable: true })
  define("location", { origin: location.origin, href: location.href })
  define("top", window)
  define("navigator", {})
  define("document", document)
  define("Node", document.defaultView.Node)
  define("MutationObserver", document.defaultView.MutationObserver)
  define("webkit", handler ? { messageHandlers: { onceAmo: { postMessage: body => { posts.push(body); return reply(body) } } } } : undefined)
  delete window.__onceAddonManager
  delete window.__onceAmoChanged
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/src/amoPageShim.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  const moduleRequire = name => {
    assert.equal(name, "@once/webext-runtime/amo")
    return amo
  }
  // `window` is undefined in the module scope, so the self-install line is inert; the test calls it.
  Function("exports", "require", "window", compiled)(exports, moduleRequire, undefined)
  return { window, document, posts, exports }
}

test("the shim stays out of pages that are not AMO's top frame or lack the native handler", () => {
  const elsewhere = harness("https://example.com")
  assert.equal(elsewhere.exports.installAmoPageShim(elsewhere.window), false)
  assert.equal(elsewhere.window.__onceAddonManager, undefined)
  const unhosted = harness("https://addons.mozilla.org", { handler: false })
  assert.equal(unhosted.exports.installAmoPageShim(unhosted.window), false)
  assert.equal(unhosted.window.navigator.mozAddonManager, undefined)
})

test("on AMO the bridge posts to the native handler and the add-on manager appears", async () => {
  const states = { "gdpr@cavi.au.dk": { id: "gdpr@cavi.au.dk", version: "1.1.5", isEnabled: true, isActive: true, canUninstall: true } }
  const ui = harness("https://addons.mozilla.org", {
    reply: async body => body.method === "addon" ? states[body.id] ?? null : body.method === "install" ? { status: "installed" } : true
  })
  assert.equal(ui.exports.installAmoPageShim(ui.window), true)
  const manager = ui.window.navigator.mozAddonManager
  assert.ok(manager, "navigator.mozAddonManager is defined")
  assert.equal(await manager.getAddonByID("missing@example"), null)
  const addon = await manager.getAddonByID("gdpr@cavi.au.dk")
  assert.equal(addon.version, "1.1.5")
  assert.equal(addon.canUninstall, true)
  const events = []
  manager.addEventListener("onDisabled", event => events.push(event.type))
  await addon.setEnabled(false)
  states["gdpr@cavi.au.dk"] = { ...states["gdpr@cavi.au.dk"], isEnabled: false, isActive: false }
  // The native side calls this global when the catalog changed.
  assert.equal(typeof ui.window.__onceAmoChanged, "function")
  await ui.window.__onceAmoChanged()
  await settle()
  assert.deepEqual(events, ["onDisabled"])
  const install = await manager.createInstall()
  const phases = []
  for (const name of ["onDownloadStarted", "onInstallEnded"]) install.addEventListener(name, () => phases.push(name))
  await install.install()
  assert.deepEqual(phases, ["onDownloadStarted", "onInstallEnded"])
  // Both add-ons the page asked about are looked up again when the catalog changes.
  assert.deepEqual(ui.posts.map(post => post.method), ["addon", "addon", "enabled", "addon", "addon", "install"])
  assert.deepEqual(ui.posts[2], { method: "enabled", id: "gdpr@cavi.au.dk", enabled: false })
})

test("a cancelled native review reports an install cancellation to AMO", async () => {
  const ui = harness("https://addons.mozilla.org", { reply: async body => body.method === "install" ? { status: "cancelled" } : null })
  ui.exports.installAmoPageShim(ui.window)
  const install = await ui.window.navigator.mozAddonManager.createInstall()
  const phases = []
  install.addEventListener("onInstallCancelled", () => phases.push("cancelled"))
  await install.install()
  assert.deepEqual(phases, ["cancelled"])
})

test("the server state is rewritten to a desktop Firefox before AMO's bundle reads it", async () => {
  const ui = harness("https://addons.mozilla.org")
  ui.exports.installAmoPageShim(ui.window)
  const script = ui.document.createElement("script")
  script.id = "redux-store-state"
  script.type = "application/json"
  script.textContent = JSON.stringify({ api: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) Safari/604.1",
    userAgentInfo: { browser: { name: "Mobile Safari", version: "26.5", major: "26" }, device: { vendor: "Apple", model: "iPhone", type: "mobile" },
      os: { name: "iOS", version: "26.5" } } } })
  ui.document.head.append(script, ui.document.createElement("script"))
  await settle()
  const state = JSON.parse(script.textContent).api
  assert.match(state.userAgent, /Firefox\/143/)
  assert.deepEqual(state.userAgentInfo, { browser: { name: "Firefox", version: "143.0", major: "143" }, device: {}, os: { name: "Windows", version: "10" } })
})
