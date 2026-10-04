const test = require("node:test")
const assert = require("node:assert/strict")
const { installStoryNavigationBackground } = require("../../../packages/webext-shell/dist/storyNavigationBackground")

function event() {
  const handlers = []
  return { addListener: handler => handlers.push(handler), emit: (...args) => handlers.map(handler => handler(...args)) }
}
function fixture(saved = {}) {
  const api = {
    storage: { session: { async get(key) { return { [key]: saved[key] } }, async set(value) { Object.assign(saved, value) }, async remove(key) { Reflect.deleteProperty(saved, key) } } },
    runtime: { id: "once", onMessage: event(), async sendMessage() {} },
    tabs: { onRemoved: event() },
    webRequest: { onBeforeRequest: event(), onBeforeRedirect: event(), onHeadersReceived: event(), onErrorOccurred: event() },
    webNavigation: { onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event() }
  }
  installStoryNavigationBackground(api)
  const get = (tabId, url) => api.runtime.onMessage.emit({ onceGetNavigation: tabId, url }, { id: "once" })[0]
  return { api, saved, get }
}

test("extension background retains multi-hop redirect provenance, status and same-document navigation across a restart", async () => {
  const { api, saved, get } = fixture()
  const start = { tabId: 1, requestId: "a", url: "https://git.btxx.org/grubby" }
  api.webRequest.onBeforeRequest.emit(start)
  api.webRequest.onBeforeRedirect.emit({ ...start, redirectUrl: "http://git.btxx.org/grubby/" })
  api.webRequest.onBeforeRequest.emit({ ...start, url: "http://git.btxx.org/grubby/" })
  api.webRequest.onBeforeRedirect.emit({ ...start, redirectUrl: "https://git.btxx.org/grubby/" })
  const final = { ...start, url: "https://git.btxx.org/grubby/", statusCode: 200 }
  api.webRequest.onBeforeRequest.emit(final)
  api.webRequest.onHeadersReceived.emit(final)
  assert.equal((await get(1, final.url)).sourceUrl, start.url)
  api.webNavigation.onReferenceFragmentUpdated.emit({ tabId: 1, frameId: 0, url: final.url + "#readme" })
  assert.equal((await get(1, final.url + "#readme")).statusCode, 200)
  api.webNavigation.onHistoryStateUpdated.emit({ tabId: 1, frameId: 0, url: "https://git.btxx.org/grubby/docs" })
  const restarted = fixture(saved)
  assert.equal((await get(1, "https://git.btxx.org/grubby/docs")).sourceUrl, start.url)
  assert.equal((await restarted.get(1, "https://git.btxx.org/grubby/docs")).sourceUrl, start.url)
  assert.equal(await get(2, final.url), null)
  api.webRequest.onBeforeRequest.emit({ tabId: 1, requestId: "b", url: "https://example.test/elsewhere" })
  api.webRequest.onErrorOccurred.emit({ ...start })
  assert.equal((await get(1, "https://example.test/elsewhere")).sourceUrl, "https://example.test/elsewhere")
  assert.equal((await get(1, "https://example.test/elsewhere")).failed, undefined)
  assert.equal(await get(1, final.url), null)
})

test("extension reports HTTP and network errors even if the URL has not changed", async () => {
  const { api, get } = fixture()
  const request = { tabId: 1, requestId: "a", url: "https://example.test/story" }
  api.webRequest.onBeforeRequest.emit(request)
  api.webRequest.onHeadersReceived.emit({ ...request, statusCode: 404 })
  assert.equal((await get(1, request.url)).statusCode, 404)
  api.webRequest.onBeforeRequest.emit({ ...request, requestId: "b" })
  api.webRequest.onBeforeRedirect.emit({ ...request, requestId: "b", redirectUrl: "https://other.test/broken" })
  api.webRequest.onErrorOccurred.emit({ ...request, requestId: "b" })
  assert.equal((await get(1, request.url)).failed, true)
})
