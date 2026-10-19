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
  frames.navigated("A", null, "https://top.test/next")
  assert.equal(frames.world(2), undefined, "a navigation drops the frame's contexts")
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

test("store documents are written as patches of the keys whose text changed", () => {
  const { diffDocuments } = lite("liteStorage")
  const first = diffDocuments({}, { a: 1, b: { c: [1, 2] }, skipped: undefined })
  assert.deepEqual(first.set, { a: "1", b: '{"c":[1,2]}' })
  assert.deepEqual(first.remove, [])
  const second = diffDocuments(first.encoded, { a: 1, b: { c: [1, 2, 3] } })
  assert.deepEqual(second.set, { b: '{"c":[1,2,3]}' })
  const third = diffDocuments(second.encoded, { b: { c: [1, 2, 3] }, d: "x" })
  assert.deepEqual(third.set, { d: '"x"' })
  assert.deepEqual(third.remove, ["a"])
})

test("a content world's blob URL of its extension's origin is routed through the broker", () => {
  const { mapBlobUrl } = lite("worldBootstrap")
  const host = "0123456789abcdef0123456789abcdef"
  const routed = `https://${host}.moz-extension.localhost/_once/blob/4b2c-uuid`
  assert.equal(mapBlobUrl(host, `blob:https://${host}.moz-extension.localhost/4b2c-uuid`), routed)
  assert.equal(mapBlobUrl(host, `blob:moz-extension://${host}/4b2c-uuid`), routed)
  assert.equal(mapBlobUrl(host, "blob:https://site.test/other"), "blob:https://site.test/other")
  assert.equal(mapBlobUrl(host, "https://site.test/x"), "https://site.test/x")
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
