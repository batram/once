const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const path = require("node:path")

test("Gecko's trusted bridge reports the original request and final HTTP status to its own document", async () => {
  let start, headers, query
  const context = vm.createContext({ URL, browser: {
    webRequest: {
      onBeforeRequest: { addListener(listener) { start = listener } },
      onHeadersReceived: { addListener(listener) { headers = listener } }
    },
    tabs: { onRemoved: { addListener() {} } },
    runtime: { onMessage: { addListener(listener) { query = listener } } }
  } })
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/extensions/once-surface/documentContext.js"), "utf8"), context)
  const original = { tabId: 7, requestId: "a", url: "https://example.test/story" }
  start(original)
  start({ ...original, url: "http://example.test/story/" })
  headers({ ...original, url: "http://example.test/story/", statusCode: 404 })
  const value = await query({ type: "once-document-context" }, { frameId: 0, tab: { id: 7 }, url: "http://example.test/story/#heading" })
  assert.equal(value.sourceUrl, original.url)
  assert.equal(value.statusCode, 404)
  assert.equal(await query({ type: "once-document-context" }, { frameId: 0, tab: { id: 7 }, url: "https://example.test/other" }), null)
  assert.equal(query({ type: "once-document-context" }, { frameId: 1, tab: { id: 7 } }), undefined)
})
