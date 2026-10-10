const assert = require("node:assert/strict")
const Module = require("node:module")
const test = require("node:test")

// Loads the built document fetch against a stand-in @capacitor/core, so the
// native path runs without a device and every plugin request is recorded.
function loadDocumentFetch({ native = true, respond = () => ({ status: 200, headers: {}, base64: "" }) } = {}) {
  const requests = []
  const webRequests = []
  global.window = {
    location: { origin: "https://localhost" },
    fetch: async (input) => { webRequests.push(String(input)); return new Response("from the web view") }
  }
  const core = {
    Capacitor: { isNativePlatform: () => native, getPlatform: () => "ios" },
    CapacitorHttp: { request: async (options) => { requests.push(["http", options]); return { status: 200, headers: {}, data: "" } } }
  }
  const load = Module._load
  Module._load = function (request, ...rest) {
    return request === "@capacitor/core" ? core : load.call(this, request, ...rest)
  }
  try {
    for (const key of Object.keys(require.cache)) {
      if (/platform-mobile[\\/]dist[\\/](nativeFetch|documentFetch)\.js$/.test(key)) Reflect.deleteProperty(require.cache, key)
    }
    const { createDocumentFetch } = require("../../../packages/platform-mobile/dist/documentFetch.js")
    const plugin = { async fetchDocument(options) { requests.push(["document", options]); return respond(options) } }
    return { fetch: createDocumentFetch(plugin, 1024), requests, webRequests }
  } finally {
    Module._load = load
  }
}

test("document GETs download natively under the byte cap, without cookies unless asked", async () => {
  const { fetch, requests } = loadDocumentFetch({ respond: () => ({ status: 200, url: "https://example.test/final.pdf", headers: { "Content-Type": "application/pdf" }, base64: Buffer.from("%PDF").toString("base64") }) })
  const response = await fetch("https://example.test/document", { headers: { Accept: "application/pdf" } })
  assert.deepEqual(requests, [["document", { url: "https://example.test/document", maxBytes: 1024, credentials: "omit", headers: { accept: "application/pdf" } }]])
  assert.equal(response.status, 200)
  assert.equal(response.url, "https://example.test/final.pdf")
  assert.equal(response.headers.get("content-type"), "application/pdf")
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array(Buffer.from("%PDF")))
  await fetch("https://example.test/private", { credentials: "include" })
  assert.equal(requests[1][1].credentials, "include")
})

test("a download the native layer refuses as too large rejects the fetch", async () => {
  const { fetch } = loadDocumentFetch({ respond: async () => { throw new Error("Document too large") } })
  await assert.rejects(fetch("https://example.test/huge.pdf"), /too large/)
})

test("same-origin, non-GET and web requests keep the ordinary fetch path", async () => {
  const { fetch, requests, webRequests } = loadDocumentFetch()
  await fetch("https://localhost/app.html")
  await fetch("https://example.test/submit", { method: "POST", body: "x" })
  assert.deepEqual(webRequests, ["https://localhost/app.html"])
  assert.equal(requests[0][0], "http")
  assert.equal(requests.filter(([kind]) => kind === "document").length, 0)
  const web = loadDocumentFetch({ native: false })
  await web.fetch("https://example.test/document")
  assert.deepEqual(web.webRequests, ["https://example.test/document"])
})
