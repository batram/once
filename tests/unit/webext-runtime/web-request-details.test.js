// The pure half of webRequest: details synthesis, filters, and the merge of
// blocking responses, exercised without any host.
const assert = require("node:assert/strict")
const test = require("node:test")
const details = require("../../../packages/webext-runtime/dist")

test("host resource types map onto WebExtension request types", () => {
  assert.equal(details.webExtResourceType("mainFrame"), "main_frame")
  assert.equal(details.webExtResourceType("xhr"), "xmlhttprequest")
  assert.equal(details.webExtResourceType("cspReport"), "csp_report")
  assert.equal(details.webExtResourceType("somethingNew"), "other")
})

test("a sub-resource carries its document, the main frame does not", () => {
  const base = {
    id: 7, method: "GET", referrer: "", timestamp: 1, tabId: 3,
    frame: { frameId: 0, parentFrameId: -1, documentUrl: "https://site.test/page", topUrl: "https://site.test/page" }
  }
  const script = details.buildWebRequestDetails({
    ...base, url: "https://cdn.ads.test/x.js", resourceType: "script",
    requestHeaders: { Accept: "*/*", Cookie: ["a=1", "b=2"] }
  })
  assert.equal(script.requestId, "7")
  assert.equal(script.type, "script")
  assert.equal(script.documentUrl, "https://site.test/page")
  assert.equal(script.originUrl, "https://site.test/page")
  assert.equal(script.thirdParty, true)
  assert.deepEqual(script.requestHeaders, [
    { name: "Accept", value: "*/*" }, { name: "Cookie", value: "a=1" }, { name: "Cookie", value: "b=2" }
  ])

  const main = details.buildWebRequestDetails({
    ...base, url: "https://site.test/next", resourceType: "mainFrame"
  })
  // Absent, not null: uBlock checks for undefined and then calls startsWith.
  assert.equal("documentUrl" in main, false)
  assert.equal("originUrl" in main, false)
  assert.equal(main.frameId, 0)
  assert.equal(main.parentFrameId, -1)
  assert.equal(main.thirdParty, false)
})

test("header conversion round-trips through the WebExtension shape", () => {
  const list = details.headersToWebExt({ "Set-Cookie": ["a", "b"], "X-One": "1" })
  assert.deepEqual(details.headersFromWebExt(list), { "Set-Cookie": ["a", "b"], "X-One": "1" })
})

test("listener filters decide by URL, type, and tab; extraInfoSpec sets capabilities", () => {
  const filter = new details.CompiledRequestFilter({
    filter: { urls: ["*://*.ads.test/*"], types: ["script", "image"], tabId: 3 },
    extraInfoSpec: ["blocking", "requestHeaders"]
  })
  const hit = { url: "https://cdn.ads.test/x.js", type: "script", tabId: 3 }
  assert.equal(filter.matches(hit), true)
  assert.equal(filter.matches({ ...hit, type: "xmlhttprequest" }), false)
  assert.equal(filter.matches({ ...hit, tabId: 4 }), false)
  assert.equal(filter.matches({ ...hit, url: "https://site.test/x.js" }), false)
  assert.equal(filter.blocking, true)
  assert.equal(filter.wantsRequestHeaders, true)
  assert.equal(filter.wantsResponseHeaders, false)
  assert.throws(() => new details.CompiledRequestFilter({ filter: { urls: [] }, extraInfoSpec: [] }))
  // Violentmonkey's installer filter names its own scheme alongside web
  // ones; the whole filter used to be discarded for it.
  const installer = new details.CompiledRequestFilter({
    filter: { urls: ["*://*/*.user.js", "moz-extension://abc/*.user.js"], types: ["main_frame"] },
    extraInfoSpec: ["blocking"]
  })
  assert.equal(installer.matches({ url: "http://127.0.0.1:1/once.user.js", type: "main_frame", tabId: 1 }), true)
})

test("blocking responses merge with Firefox precedence", () => {
  const merged = details.mergeBlockingResponses([
    undefined,
    { redirectUrl: "https://first.test/" },
    { requestHeaders: [{ name: "A", value: "1" }] },
    { redirectUrl: "https://second.test/", requestHeaders: [{ name: "B", value: "2" }] },
    { cancel: true },
    "not an object"
  ])
  assert.deepEqual(merged, {
    cancel: true,
    redirectUrl: "https://first.test/",
    requestHeaders: [{ name: "B", value: "2" }]
  })
})

test("a document response is held for onResponseStarted; redirects and sub-resources are not", () => {
  assert.equal(details.startsDocument("main_frame", 200), true)
  assert.equal(details.startsDocument("sub_frame", 404), true)
  assert.equal(details.startsDocument("main_frame", 302), false)
  assert.equal(details.startsDocument("main_frame", 304), false)
  assert.equal(details.startsDocument("xmlhttprequest", 200), false)
  assert.equal(details.startsDocument("script", 200), false)
})
