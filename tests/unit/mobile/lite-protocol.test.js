// The pure parts of the Lite broker protocol: URL mapping between the two
// forms an extension's pages have, resource type mapping, the document nonce
// and the policy it is added to, the catalogue shape, and frame bookkeeping.
const assert = require("node:assert/strict")
const test = require("node:test")
const { lite } = require("./lite-support")

const protocol = lite("protocol")
const webRequest = lite("liteWebRequest")
const { TargetFrames } = lite("liteFrames")
const { catalogEntry } = lite("liteManagement")

test("moz-extension and https page URLs map onto each other in both directions", () => {
  const host = "0123456789abcdef0123456789abcdef"
  const page = `https://${host}.moz-extension.localhost/ui/popup.html?x=1#top`
  assert.equal(protocol.pageUrlFromExtensionUrl(`moz-extension://${host}/ui/popup.html?x=1#top`), page)
  assert.equal(protocol.extensionUrlFromPageUrl(page), `moz-extension://${host}/ui/popup.html?x=1#top`)
  assert.equal(protocol.pageHostOf(page), host)
  assert.equal(protocol.pageHostOf(`moz-extension://${host}/a`), host)
  assert.equal(protocol.pageHostOf("https://example.test/"), null)
  assert.equal(protocol.pageHostOf("https://a.b.moz-extension.localhost/"), null, "one label only")
  assert.equal(protocol.pageUrlFromExtensionUrl("https://example.test/x"), "https://example.test/x")
  assert.equal(protocol.extensionUrlFromPageUrl("https://example.test/x"), "https://example.test/x")
  assert.equal(protocol.pageOrigin(host), `https://${host}.moz-extension.localhost`)
  assert.equal(protocol.worldNameFor(host), `once-ext:${host}`)
})

test("DevTools resource types become the names the shared router understands", () => {
  const { electronResourceType } = protocol
  assert.equal(electronResourceType("Document", true), "mainFrame")
  assert.equal(electronResourceType("Document", false), "subFrame")
  for (const [cdp, expected] of [
    ["Stylesheet", "stylesheet"], ["Image", "image"], ["Media", "media"], ["Font", "font"], ["Script", "script"],
    ["TextTrack", "other"], ["XHR", "xhr"], ["Fetch", "xhr"], ["Prefetch", "other"], ["EventSource", "other"],
    ["WebSocket", "webSocket"], ["Manifest", "other"], ["SignedExchange", "other"], ["Ping", "ping"],
    ["CSPViolationReport", "cspReport"], ["Preflight", "other"], ["Other", "other"], ["Unknown", "other"]
  ]) assert.equal(electronResourceType(cdp, true), expected, cdp)
})

test("the document nonce joins script-src, falls back to default-src and never disables unsafe-inline", () => {
  const nonce = webRequest.documentNonce("secret", "https://site.test/page#frag")
  assert.equal(nonce, webRequest.documentNonce("secret", "https://site.test/page"), "fragment ignored")
  assert.notEqual(nonce, webRequest.documentNonce("other", "https://site.test/page"))
  assert.equal(webRequest.addNonceToPolicy("default-src 'self'; script-src 'self' https://cdn.test", nonce),
    `default-src 'self'; script-src 'self' https://cdn.test 'nonce-${nonce}'`)
  assert.equal(webRequest.addNonceToPolicy("default-src 'self'", nonce), `default-src 'self' 'nonce-${nonce}'`)
  assert.equal(webRequest.addNonceToPolicy("script-src 'none'", nonce), `script-src 'nonce-${nonce}'`)
  assert.equal(webRequest.addNonceToPolicy("script-src 'self' 'unsafe-inline'", nonce), "script-src 'self' 'unsafe-inline'")
  assert.equal(webRequest.addNonceToPolicy("img-src 'self'", nonce), "img-src 'self'")
  const headers = webRequest.withDocumentNonce([
    { name: "Content-Type", value: "text/html" }, { name: "Content-Security-Policy", value: "script-src 'self'" }
  ], nonce)
  assert.equal(headers[1].value, `script-src 'self' 'nonce-${nonce}'`)
  const cors = webRequest.withCorsGrant([{ name: "Access-Control-Allow-Origin", value: "x" }, { name: "ETag", value: "1" }], "https://o")
  assert.deepEqual(cors.map((header) => header.name), ["ETag", "Access-Control-Allow-Origin", "Access-Control-Allow-Credentials", "Access-Control-Allow-Headers", "Access-Control-Allow-Methods", "Access-Control-Expose-Headers"])
  assert.equal(cors[1].value, "https://o")
})

test("frames keep Chromium ids as strings and expose stable WebExtension ids", () => {
  const frames = new TargetFrames()
  frames.snapshot({ frame: { id: "A", url: "https://top.test/" }, childFrames: [{ frame: { id: "B", parentId: "A", url: "https://child.test/" } }] })
  assert.equal(frames.webextFrameId("A"), 0)
  const child = frames.webextFrameId("B")
  assert.ok(child > 0)
  assert.deepEqual(frames.facts("B"), { frameId: child, parentFrameId: 0, documentUrl: "https://child.test/", topUrl: "https://top.test/" })
  assert.deepEqual(frames.facts("A"), { frameId: 0, parentFrameId: -1, documentUrl: "https://top.test/", topUrl: "https://top.test/" })
  frames.attached("C", "B")
  frames.navigated("C", "B", "about:blank")
  assert.equal(frames.creatorUrl("C"), "https://child.test/")
  assert.equal(frames.webextFrameId("B"), child, "stable across events")
  frames.contextCreated({ id: 1, name: "", auxData: { frameId: "A", isDefault: true } })
  frames.contextCreated({ id: 2, name: "once-ext:h", auxData: { frameId: "A", isDefault: false } })
  assert.equal(frames.mainContextId("A"), 1)
  assert.deepEqual(frames.world(2), { contextId: 2, frameId: "A", name: "once-ext:h" })
  // Chromium may report the new document's contexts before the navigation itself: they stay.
  frames.contextCreated({ id: 3, name: "once-ext:h", auxData: { frameId: "A", isDefault: false } })
  frames.navigated("A", null, "https://top.test/next")
  assert.deepEqual(frames.world(3), { contextId: 3, frameId: "A", name: "once-ext:h" })
  assert.equal(frames.mainContextId("A"), 1)
  // The old document's go with their destruction.
  frames.contextDestroyed(2)
  assert.equal(frames.world(2), undefined)
  assert.equal(frames.frameIdFor(0), "A")
  frames.detached("B")
  assert.equal(frames.facts("B").frameId, 0)
})

test("the catalogue entry has the MobileBrowserExtension shape", () => {
  const entry = catalogEntry({
    id: "x@test", host: "h", name: "X", version: "1", description: "d", icon: "data:image/png;base64,AA", enabled: true,
    running: true, bundled: false, source: "file", error: undefined, hasOptions: true, hasPopup: false, permissions: ["tabs"], warnings: []
  })
  assert.deepEqual(entry, {
    id: "x@test", name: "X", iconDataUrl: "data:image/png;base64,AA", description: "d", version: "1", enabled: true,
    bundled: false, hasOptions: true, hasAction: false, permissions: ["tabs"], disabledReason: ""
  })
  assert.equal(catalogEntry({ ...entry, icon: null, error: "broken", hasPopup: true, permissions: [], warnings: [] }).iconDataUrl, undefined)
  assert.equal(catalogEntry({ ...entry, icon: null, error: "broken", hasPopup: true, permissions: [], warnings: [] }).disabledReason, "broken")
})

test("extension storage writes only the keys that changed, without serialising the rest", async () => {
  const { ExtensionStorage } = require("@once/webext-runtime")
  const calls = []
  let stringified = 0
  const huge = { toJSON: () => { stringified += 1; return "huge" } }
  const store = {
    read: async () => ({ big: "kept", other: 1 }),
    write: async (name, value) => { calls.push(["write", Object.keys(value)]) },
    patch: async (name, set, remove) => { calls.push(["patch", Object.keys(set), remove]) }
  }
  const storage = new ExtensionStorage(store, "storage.json")
  await storage.set({ huge })
  const before = stringified
  await storage.set({ a: 1 })
  await storage.remove(["other"])
  await storage.flush()
  assert.deepEqual(calls, [["patch", ["huge", "a"], ["other"]]])
  calls.length = 0
  await storage.set({ a: 2 })
  await storage.flush()
  assert.deepEqual(calls, [["patch", ["a"], []]], "the unchanged huge value is not written again")
  assert.equal(stringified, before, "nor serialised")
  // A failed patch leaves the document on disk unknown: the next write is whole.
  store.patch = async () => { throw new Error("disk full") }
  await storage.set({ a: 3 })
  await storage.flush()
  calls.length = 0
  await storage.set({ a: 4 })
  await storage.flush()
  assert.deepEqual(calls, [["write", ["big", "huge", "a"]]])
})

test("a content world's blob URL of its extension's origin is routed to its document's keyed answer", () => {
  const { mapBlobUrl, worldSyncKey } = lite("worldBootstrap")
  const { syncKey } = lite("liteSync")
  const host = "0123456789abcdef0123456789abcdef"
  const token = "fedcba9876543210fedcba9876543210"
  const page = "https://site.test/page#top"
  // The world and the broker name the same answer; no other document's key follows from it.
  assert.equal(worldSyncKey(token, page), syncKey(token, "https://site.test/page"))
  assert.notEqual(syncKey(token, "https://site.test/page"), syncKey(token, "https://site.test/other"))
  assert.notEqual(syncKey(token, "https://site.test/page"), syncKey("another-token", "https://site.test/page"))
  const key = syncKey(token, page)
  const routed = `https://${host}.moz-extension.localhost/_once/${key}/blob/4b2c-uuid?u=${encodeURIComponent("https://site.test/page")}`
  assert.equal(mapBlobUrl(host, `blob:https://${host}.moz-extension.localhost/4b2c-uuid`, token, page), routed)
  assert.equal(mapBlobUrl(host, `blob:moz-extension://${host}/4b2c-uuid`, token, page), routed)
  assert.equal(mapBlobUrl(host, "blob:https://site.test/other", token, page), "blob:https://site.test/other")
  assert.equal(mapBlobUrl(host, "https://site.test/x", token, page), "https://site.test/x")
})

test("extension pages map moz-extension URLs in fetch, Request, XMLHttpRequest and element sources", () => {
  const { mapExtensionUrls } = lite("pageBootstrap")
  const { parseHTML } = require("linkedom")
  const { window, document } = parseHTML("<html><body></body></html>")
  const host = "0123456789abcdef0123456789abcdef"
  const calls = []
  function FakeRequest(input, init) { this.url = String(input); this.init = init }
  class FakeXhr { open(method, url) { calls.push(["xhr", method, String(url)]) } }
  const scope = {
    fetch: (input) => { calls.push(["fetch", String(input instanceof URL ? input.href : input)]); return Promise.resolve() },
    Request: FakeRequest,
    XMLHttpRequest: FakeXhr,
    navigator: { sendBeacon: (url) => { calls.push(["beacon", String(url)]); return true } },
    HTMLImageElement: window.HTMLImageElement, HTMLScriptElement: window.HTMLScriptElement, HTMLIFrameElement: window.HTMLIFrameElement,
    HTMLMediaElement: window.HTMLMediaElement, HTMLSourceElement: window.HTMLSourceElement, HTMLLinkElement: window.HTMLLinkElement,
    HTMLAnchorElement: window.HTMLAnchorElement, Element: window.Element, URL
  }
  mapExtensionUrls(scope)
  const mapped = `https://${host}.moz-extension.localhost/x.json`
  void scope.fetch(`moz-extension://${host}/x.json`)
  void scope.fetch(new URL(`moz-extension://${host}/x.json`))
  void scope.fetch("https://other.test/")
  new scope.XMLHttpRequest().open("GET", `moz-extension://${host}/x.json`)
  scope.navigator.sendBeacon(`moz-extension://${host}/x.json`)
  assert.deepEqual(calls, [["fetch", mapped], ["fetch", mapped], ["fetch", "https://other.test/"], ["xhr", "GET", mapped], ["beacon", mapped]])
  assert.equal(new scope.Request(`moz-extension://${host}/x.json`, { method: "POST" }).url, mapped)
  const image = document.createElement("img")
  image.setAttribute("src", `moz-extension://${host}/icon.png`)
  assert.equal(image.getAttribute("src"), `https://${host}.moz-extension.localhost/icon.png`)
  const anchor = document.createElement("a")
  anchor.setAttribute("href", "https://other.test/")
  assert.equal(anchor.getAttribute("href"), "https://other.test/")
})

test("the bridge world relays nothing from the main world but PiP requests, and entering only with the page's user activation", () => {
  // The module installs itself on load; outside a top window it does nothing.
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { value: { top: {} }, configurable: true, writable: true })
  let pipRequestFromMain
  try {
    ({ pipRequestFromMain } = lite("bridgeWorld"))
  } finally {
    if (saved) Object.defineProperty(globalThis, "window", saved)
    else Reflect.deleteProperty(globalThis, "window")
  }
  const idle = { activated: false, inPictureInPicture: false }
  const tapped = { activated: true, inPictureInPicture: false }
  // A page that learnt the channel's token can forge script answers, media reports or image-text requests: all dropped.
  assert.equal(pipRequestFromMain(JSON.stringify({ id: 4, value: "\"forged\"" }), tapped), null)
  assert.equal(pipRequestFromMain(JSON.stringify({ type: "media-snapshot", playing: true }), tapped), null)
  assert.equal(pipRequestFromMain(JSON.stringify({ type: "image-text-request", image: "https://x.test/a.png" }), tapped), null)
  assert.equal(pipRequestFromMain("not json", tapped), null)
  const enter = { type: "pip-request", id: 2, action: "enter", width: 640, height: 360, extra: "dropped",
    rect: { x: 1, y: 2, width: 3, height: 4, viewportWidth: 5, viewportHeight: 6 } }
  assert.equal(pipRequestFromMain(JSON.stringify(enter), idle), null, "no gesture, not in PiP")
  assert.deepEqual(pipRequestFromMain(JSON.stringify(enter), tapped), { type: "pip-request", id: 2, action: "enter", width: 640, height: 360,
    rect: { x: 1, y: 2, width: 3, height: 4, viewportWidth: 5, viewportHeight: 6 } })
  assert.equal(pipRequestFromMain(JSON.stringify(enter), { activated: false, inPictureInPicture: true }).action, "enter", "switching videos in PiP")
  assert.deepEqual(pipRequestFromMain(JSON.stringify({ type: "pip-request", id: 3, action: "exit" }), idle), { type: "pip-request", id: 3, action: "exit" })
})

test("Java-backed timers never take an id the page's own timers use", () => {
  const { JavaChannel, installNativeTimers, NATIVE_TIMER_BASE } = lite("javaChannel")
  const sent = []
  const port = { onmessage: null, postMessage: (text) => sent.push(JSON.parse(text)) }
  const channel = new JavaChannel(port)
  // The page's own timers as Blink numbers them: 1, 2, 3, …
  const saved = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
  let nextPage = 1
  const cleared = []
  globalThis.setTimeout = () => nextPage++
  globalThis.clearTimeout = (id) => cleared.push(id)
  try {
    const restore = installNativeTimers(channel, 5000)
    const native = setTimeout(() => undefined, 60_000)
    assert.ok(native >= NATIVE_TIMER_BASE)
    for (let index = 0; index < 10; index++) setTimeout(() => undefined, 10)
    for (let id = 1; id <= 10; id++) clearTimeout(id)
    assert.deepEqual(cleared, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "the page's timers are cleared in the page")
    assert.equal(sent.filter((envelope) => envelope.event === "timer.clear").length, 0, "Java's timer stays set")
    clearTimeout(native)
    assert.equal(sent.filter((envelope) => envelope.event === "timer.clear").length, 1)
    restore()
  } finally {
    globalThis.setTimeout = saved.setTimeout
    globalThis.clearTimeout = saved.clearTimeout
  }
})

test("the connect grant leaves default-src as narrow as it was and reaches report-only policies", () => {
  const { withConnectGrant, withDocumentNonce } = lite("liteWebRequest")
  const origin = "https://0123.moz-extension.localhost"
  const [enforced, reportOnly, other] = withDocumentNonce(withConnectGrant([
    { name: "Content-Security-Policy", value: "default-src 'self' https://cdn.test" },
    { name: "Content-Security-Policy-Report-Only", value: "default-src 'none'; report-uri /r" },
    { name: "Content-Type", value: "text/html" }
  ], [origin]), "abc")
  assert.equal(enforced.value, `default-src 'self' https://cdn.test 'nonce-abc'; connect-src 'self' https://cdn.test ${origin}`)
  assert.equal(reportOnly.value, `default-src 'nonce-abc'; report-uri /r; connect-src ${origin}`)
  assert.equal(other.value, "text/html")
})
