// The content-world bootstrap in a DOM: it greets the broker, runs the
// matching scripts at document_start, inserts styles, answers injection
// events, derives the same nonce the broker added, falls back to main-world
// evaluation when the policy refuses inline scripts, and reaches the main
// world's globals through the helper's event channel.
const assert = require("node:assert/strict")
const test = require("node:test")
const { parseHTML } = require("linkedom")
const { lite } = require("./lite-support")

const { bootWorld, worldNonce, worldSyncKey, accessEventName, accessAttribute } = lite("worldBootstrap")
const { documentNonce } = lite("liteWebRequest")
const { WORLD_BINDING, WORLD_DELIVER } = lite("protocol")

const TOKEN = "fedcba9876543210fedcba9876543210"
/** The main-world helper's channel: not the secret the nonce and the answer keys derive from. */
const CHANNEL = "00112233445566778899aabbccddeeff"
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
    channel: CHANNEL,
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
  // Scripts in the world reach the broker through the API only; the binding is the world's own.
  assert.equal(scope[WORLD_BINDING], undefined, "the binding is taken off the global")
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
      // Scripts run with a sandbox as `this`: not the world's window, forwarding to it, and its own `window`.
      scope[WORLD_DELIVER](JSON.stringify({ type: "event", message: { api: "__content", event: "executeScript", args: [{ code: "[this !== window, this.document === document, typeof this.setTimeout]" }], token: 11 } }))
      assert.deepEqual(sent.at(-1), { host: HOST, type: "reply", token: 11, result: [[true, true, "function"]] })
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
  assert.notEqual(accessEventName(CHANNEL), accessEventName(TOKEN))
  document.addEventListener(accessEventName(CHANNEL), (event) => {
    const { op, name } = JSON.parse(event.detail)
    const answer = op === "get" ? mainGlobals[name] : op === "has" ? name in mainGlobals : Reflect.deleteProperty(mainGlobals, name)
    const encoded = JSON.stringify(answer)
    if (encoded !== undefined) document.documentElement.setAttribute(accessAttribute(CHANNEL), encoded)
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
  assert.equal(document.documentElement.hasAttribute(accessAttribute(CHANNEL)), false, "the answer is cleared")
}))

test("blank frames match by their top URL only with match_about_blank and inherit the parent's nonce", () => withDom("about:blank", ({ window }) => {
  const { selectScripts } = lite("worldBootstrap")
  const scripts = [script({}), script({ matchAboutBlank: true, allFrames: true })]
  assert.equal(selectScripts(scripts, { url: "about:blank", topUrl: "https://www.site.test/", isTop: false }).length, 1)
  assert.equal(selectScripts(scripts, { url: "about:blank", topUrl: "https://other.test/", isTop: false }).length, 0)
  void window
}))

test("registered scripts are asked for synchronously at boot and run like the manifest's", () => withDom("https://www.site.test/page", ({ sent, boot, scope }) => {
  const { addDynamicScripts } = lite("worldBootstrap")
  delete globalThis.__dynamicRan
  let cookies = ""
  Object.defineProperty(document, "cookie", { configurable: true, get: () => cookies, set: (value) => { cookies += `${value.split(";")[0]}; ` } })
  const requests = []
  class FakeXhr {
    open(method, url, async) { requests.push([method, url, async]) }
    send() {
      this.status = 200
      this.responseText = JSON.stringify({ host: HOST, cookie: `${HOST}=blob-1`, scripts: [script({ js: [{ url: "d", code: "globalThis.__dynamicRan = (globalThis.__dynamicRan || 0) + 1" }], css: [] })] })
    }
  }
  scope.XMLHttpRequest = FakeXhr
  try {
    const world = boot(config([]))
    const key = worldSyncKey(TOKEN, "https://www.site.test/page")
    assert.deepEqual(requests, [["GET", `https://${HOST}.moz-extension.localhost/_once/${key}/dynamic?u=${encodeURIComponent("https://www.site.test/page")}`, false]])
    assert.equal(globalThis.__dynamicRan, 1, "the registered script ran at document start")
    assert.ok(String(document.cookie).includes(`${HOST}=blob-1`), `the document got the cookie: ${document.cookie}`)
    addDynamicScripts({ host: "other", scripts: [script({ js: [{ url: "d3", code: "globalThis.__dynamicRan += 100" }], css: [] })] }, scope)
    assert.equal(globalThis.__dynamicRan, 1, "another extension's scripts are not this world's")
    // A second boot in the same context (a new DevTools session) hands back the same world,
    // takes the binding installed again and greets the broker, which may have forgotten it.
    const resent = []
    globalThis[WORLD_BINDING] = (payload) => resent.push(JSON.parse(payload))
    const again = boot(config([script({})]))
    assert.equal(again, world)
    assert.equal(sent.filter((m) => m.type === "hello").length, 1)
    assert.deepEqual(resent.map((m) => m.type), ["hello"])
    assert.equal(globalThis[WORLD_BINDING], undefined)
    assert.equal(requests.length, 1)
  } finally {
    Reflect.deleteProperty(scope, "XMLHttpRequest")
  }
}))
