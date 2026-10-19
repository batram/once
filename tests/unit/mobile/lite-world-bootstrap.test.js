// The content-world bootstrap in a DOM: it greets the broker, runs the
// matching scripts at document_start, inserts styles, answers injection
// events, derives the same nonce the broker added, falls back to main-world
// evaluation when the policy refuses inline scripts, and reaches the main
// world's globals through the helper's event channel.
const assert = require("node:assert/strict")
const test = require("node:test")
const { parseHTML } = require("linkedom")
const { lite } = require("./lite-support")

const { bootWorld, worldNonce, accessEventName, accessAttribute } = lite("worldBootstrap")
const { documentNonce } = lite("liteWebRequest")
const { WORLD_BINDING, WORLD_DELIVER } = lite("protocol")

const TOKEN = "fedcba9876543210fedcba9876543210"
const HOST = "0123456789abcdef0123456789abcdef"

async function withDom(url, run) {
  const { window, document } = parseHTML("<!DOCTYPE html><html><head></head><body></body></html>")
  const saved = {}
  const globals = {
    window, document, location: new URL(url), MutationObserver: window.MutationObserver,
    CustomEvent: window.CustomEvent, HTMLScriptElement: window.HTMLScriptElement, HTMLStyleElement: window.HTMLStyleElement,
    Node: window.Node, Document: window.Document, Element: window.Element, Event: window.Event
  }
  try { window.top = window; window.parent = window } catch { /* read-only in some builds */ }
  for (const [name, value] of Object.entries(globals)) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  const sent = []
  globalThis[WORLD_BINDING] = (payload) => sent.push(JSON.parse(payload))
  const scope = globalThis
  let world = null
  const boot = (cfg) => { world = bootWorld(cfg, scope); return world }
  try {
    return await run({ window, document, sent, scope, boot })
  } finally {
    world?.dispose()
    for (const name of [WORLD_BINDING, WORLD_DELIVER, "browser", "chrome", "wrappedJSObject", "__onceExtensionApi"]) Reflect.deleteProperty(globalThis, name)
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
}

function config(scripts) {
  return {
    init: { id: "fixture@once.test", host: HOST, kind: "content", manifest: { name: "Fixture" }, messages: {}, uiLanguage: "en" },
    token: TOKEN,
    scripts
  }
}

const script = (overrides) => ({
  matches: ["https://*.site.test/*"], excludeMatches: [], allFrames: false, matchAboutBlank: false, runAt: "document_start",
  world: "ISOLATED", js: [{ url: `moz-extension://${HOST}/content.js`, code: "globalThis.__worldRan = (globalThis.__worldRan || 0) + 1" }],
  css: ["body { color: red }"], ...overrides
})

test("the world greets the broker, runs matching scripts and styles, and answers API calls", () => withDom("https://www.site.test/page", ({ document, sent, scope, boot }) => {
  delete globalThis.__worldRan
  const world = boot(config([script({}), script({ matches: ["https://other.test/*"], js: [{ url: "x", code: "globalThis.__other = 1" }] })]), scope)
  assert.ok(world)
  assert.deepEqual(sent[0], { host: HOST, type: "hello", url: "https://www.site.test/page", topUrl: "https://www.site.test/page", creatorUrl: "", matched: true })
  assert.equal(globalThis.__worldRan, 1, "document_start ran since documentElement exists")
  assert.equal(globalThis.__other, undefined)
  assert.equal(document.querySelector("style").textContent, "body { color: red }")
  assert.equal(typeof scope.browser.runtime.sendMessage, "function")
  assert.equal(scope.browser.runtime.getURL("a.html"), `https://${HOST}.moz-extension.localhost/a.html`, "content worlds get the loadable form")
  assert.equal(scope.chrome, scope.browser)
  const reply = scope.browser.runtime.sendMessage("hi")
  const invoke = sent.find((message) => message.type === "invoke")
  assert.deepEqual(invoke, { host: HOST, type: "invoke", id: 1, api: "runtime", method: "sendMessage", args: ["hi"] })
  scope[WORLD_DELIVER](JSON.stringify({ type: "result", id: 1, result: { ok: true, value: "yo" } }))
  return reply.then((value) => {
    assert.equal(value, "yo")
    // Listener registration travels synchronously; an event comes back through deliver.
    const seen = []
    scope.browser.runtime.onMessage.addListener((message) => { seen.push(message); return Promise.resolve("answer") })
    assert.deepEqual(sent.at(-1), { host: HOST, type: "listen", change: { action: "add", api: "runtime", event: "onMessage", id: 1 } })
    scope[WORLD_DELIVER](JSON.stringify({ type: "event", message: { api: "runtime", event: "onMessage", args: ["ping", {}], token: 9, listeners: [1] } }))
    return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
      assert.deepEqual(seen, ["ping"])
      assert.deepEqual(sent.at(-1), { host: HOST, type: "reply", token: 9, result: ["answer"] })
      // Injection events: CSS in and out, a script with its result.
      scope[WORLD_DELIVER](JSON.stringify({ type: "event", message: { api: "__content", event: "insertCSS", args: [{ css: "p { }" }] } }))
      assert.equal(document.querySelectorAll("style").length, 2)
      scope[WORLD_DELIVER](JSON.stringify({ type: "event", message: { api: "__content", event: "removeCSS", args: [{ css: "p { }" }] } }))
      assert.equal(document.querySelectorAll("style").length, 1)
      scope[WORLD_DELIVER](JSON.stringify({ type: "event", message: { api: "__content", event: "executeScript", args: [{ code: "1 + 2" }], token: 10 } }))
      assert.deepEqual(sent.at(-1), { host: HOST, type: "reply", token: 10, result: [3] })
    })
  })
}))

test("the world derives the broker's nonce and falls back to main-world evaluation when inline scripts cannot run", () => withDom("https://www.site.test/page#f", ({ document, sent, boot, scope }) => {
  assert.equal(worldNonce(TOKEN, "https://www.site.test/page#f"), documentNonce(TOKEN, "https://www.site.test/page"))
  boot(config([script({ world: "MAIN", js: [{ url: "s", code: "window.__scriptlet = 1" }], css: [] })]), scope)
  // linkedom never executes inline scripts: the probe fails as under a <meta> policy.
  const evaluated = sent.find((message) => message.type === "main-eval")
  assert.ok(evaluated)
  assert.match(evaluated.code, /__scriptlet = 1/)
  // The extension's own <script> insertions take the same route.
  const element = document.createElement("script")
  assert.equal(element.nonce, worldNonce(TOKEN, "https://www.site.test/page"), "created scripts carry the nonce")
  element.textContent = "window.__own = 2"
  document.documentElement.appendChild(element)
  assert.match(sent.at(-1).code, /__own = 2/)
}))

test("wrappedJSObject reads, probes and deletes main-world globals through the helper's channel", () => withDom("https://www.site.test/", ({ document, boot }) => {
  const mainGlobals = { sentinel: "ran", nested: { a: 1 } }
  document.addEventListener(accessEventName(TOKEN), (event) => {
    const { op, name } = JSON.parse(event.detail)
    const answer = op === "get" ? mainGlobals[name] : op === "has" ? name in mainGlobals : Reflect.deleteProperty(mainGlobals, name)
    const encoded = JSON.stringify(answer)
    if (encoded !== undefined) document.documentElement.setAttribute(accessAttribute(TOKEN), encoded)
  })
  const scope = globalThis
  boot(config([]))
  assert.equal(scope.wrappedJSObject.sentinel, "ran")
  assert.deepEqual(scope.wrappedJSObject.nested, { a: 1 })
  assert.equal("sentinel" in scope.wrappedJSObject, true)
  assert.equal("missing" in scope.wrappedJSObject, false)
  assert.equal(scope.wrappedJSObject.missing, undefined)
  delete scope.wrappedJSObject.sentinel
  assert.equal(scope.wrappedJSObject.sentinel, undefined)
  assert.equal(document.documentElement.hasAttribute(accessAttribute(TOKEN)), false, "the answer is cleared")
}))

test("blank frames match by their top URL only with match_about_blank and inherit the parent's nonce", () => withDom("about:blank", ({ window }) => {
  const { selectScripts } = lite("worldBootstrap")
  const scripts = [script({}), script({ matchAboutBlank: true, allFrames: true })]
  assert.equal(selectScripts(scripts, { url: "about:blank", topUrl: "https://www.site.test/", isTop: false }).length, 1)
  assert.equal(selectScripts(scripts, { url: "about:blank", topUrl: "https://other.test/", isTop: false }).length, 0)
  void window
}))
