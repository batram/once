const assert = require("node:assert/strict")
const Module = require("node:module")
const test = require("node:test")

// Loads the built fetch modules against a stand-in @capacitor/core, so the
// native path runs without a device and every plugin request is recorded.
function loadFetchModules({ native = true, respond = () => ({ status: 200, headers: {}, data: "" }) } = {}) {
  const pluginRequests = []
  const webRequests = []
  global.window = {
    location: { origin: "https://localhost" },
    fetch: async (input) => {
      webRequests.push(String(input))
      return new Response("from the web view")
    }
  }
  const core = {
    Capacitor: { isNativePlatform: () => native },
    CapacitorHttp: {
      request: async (options) => {
        pluginRequests.push(options)
        return respond(options)
      }
    }
  }
  const load = Module._load
  Module._load = function (request, ...rest) {
    return request === "@capacitor/core" ? core : load.call(this, request, ...rest)
  }
  try {
    for (const key of Object.keys(require.cache)) {
      if (/platform-mobile[\\/]dist[\\/](nativeFetch|addonFetch)\.js$/.test(key)) Reflect.deleteProperty(require.cache, key)
    }
    return {
      ...require("../../../packages/platform-mobile/dist/nativeFetch.js"),
      ...require("../../../packages/platform-mobile/dist/addonFetch.js"),
      pluginRequests,
      webRequests
    }
  } finally {
    Module._load = load
  }
}

test("cross-origin requests go through the native plugin as text, without cookies", async () => {
  const { nativeFetch, pluginRequests, webRequests } = loadFetchModules({
    respond: () => ({
      status: 200,
      headers: { "Content-Type": "application/json" },
      data: { items: [1, 2] },
      url: "https://feeds.example/final"
    })
  })
  const response = await nativeFetch("https://feeds.example/list", { headers: { Accept: "application/json" } })
  assert.deepEqual(await response.json(), { items: [1, 2] })
  assert.equal(response.url, "https://feeds.example/final")
  assert.equal(webRequests.length, 0)
  assert.equal(pluginRequests.length, 1)
  const [sent] = pluginRequests
  assert.equal(sent.url, "https://feeds.example/list")
  assert.equal(sent.method, "GET")
  assert.equal(sent.data, undefined)
  assert.equal(sent.responseType, "text")
  assert.equal(sent.headers.accept, "application/json")
  assert.equal(sent.headers.Cookie, "")
})

test("request bodies travel as text and credentials: include keeps cookies", async () => {
  const { nativeFetch, pluginRequests } = loadFetchModules({
    respond: () => ({ status: 201, headers: {}, data: "created" })
  })
  const response = await nativeFetch("https://couch.example/db/_bulk_docs", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docs: [] })
  })
  assert.equal(response.status, 201)
  assert.equal(await response.text(), "created")
  const [sent] = pluginRequests
  assert.equal(sent.method, "POST")
  assert.equal(sent.data, "{\"docs\":[]}")
  assert.equal(sent.headers["content-type"], "application/json")
  assert.equal("Cookie" in sent.headers, false)
})

test("null-body statuses produce empty responses", async () => {
  const { nativeFetch } = loadFetchModules({
    respond: () => ({ status: 204, headers: {}, data: "" })
  })
  const response = await nativeFetch("https://api.example/item", { method: "DELETE" })
  assert.equal(response.status, 204)
  assert.equal(response.body, null)
})

test("same-origin and non-http requests stay with the web view", async () => {
  const { nativeFetch, pluginRequests, webRequests } = loadFetchModules()
  await nativeFetch("https://localhost/picker-injection.js")
  await nativeFetch("data:text/plain,hello")
  assert.deepEqual(webRequests, ["https://localhost/picker-injection.js", "data:text/plain,hello"])
  assert.equal(pluginRequests.length, 0)
})

test("off the native platforms everything uses the web view and the global is untouched", async () => {
  const { nativeFetch, installNativeFetch, pluginRequests, webRequests } = loadFetchModules({ native: false })
  const original = window.fetch
  installNativeFetch()
  assert.equal(window.fetch, original)
  await nativeFetch("https://feeds.example/list")
  assert.deepEqual(webRequests, ["https://feeds.example/list"])
  assert.equal(pluginRequests.length, 0)
})

test("installNativeFetch replaces the global fetch on the native platforms", () => {
  const { nativeFetch, installNativeFetch } = loadFetchModules()
  installNativeFetch()
  assert.equal(window.fetch, nativeFetch)
})

test("an aborted request never reaches the plugin", async () => {
  const { nativeFetch, pluginRequests } = loadFetchModules()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(nativeFetch("https://feeds.example/list", { signal: controller.signal }), { name: "AbortError" })
  assert.equal(pluginRequests.length, 0)
})

test("add-on connections refuse the app's own origin and never send cookies", async () => {
  const { mobileAddonFetch, pluginRequests, webRequests } = loadFetchModules({
    respond: () => ({ status: 200, headers: {}, data: "ok" })
  })
  await assert.rejects(
    mobileAddonFetch("https://localhost/_capacitor_file_/data/user/0/com.zmarn.once/files/x"),
    /Only remote http\(s\) URLs/
  )
  assert.equal(webRequests.length, 0)
  const response = await mobileAddonFetch("https://api.example/v1", { credentials: "include" })
  assert.equal(await response.text(), "ok")
  const [sent] = pluginRequests
  assert.equal(sent.headers.Cookie, "")
  assert.equal(sent.disableRedirects, true)
  assert.equal(sent.connectTimeout, 120_000)
  assert.equal(sent.readTimeout, 120_000)
})

test("add-on connections reject redirects and oversized responses", async () => {
  const redirecting = loadFetchModules({
    respond: () => ({ status: 302, headers: { Location: "https://elsewhere.example/" }, data: "" })
  })
  await assert.rejects(redirecting.mobileAddonFetch("https://api.example/v1"), /redirects are not allowed/)
  const oversized = loadFetchModules({
    respond: () => ({ status: 200, headers: {}, data: "x".repeat(1024 * 1024 + 1) })
  })
  await assert.rejects(oversized.mobileAddonFetch("https://api.example/v1"), /too large/)
})
