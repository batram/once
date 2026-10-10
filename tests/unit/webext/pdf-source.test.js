const test = require("node:test")
const assert = require("node:assert/strict")
const { isPdfSource, pdfResponse, watchPdfSources } = require("../../../packages/webext-shell/dist/pdfSource")

function event() {
  const listeners = []
  return {
    listeners,
    addListener(listener, filter, extra) { listeners.push({ listener, filter, extra }) },
    removeListener(listener) { const index = listeners.findIndex(entry => entry.listener === listener); if (index >= 0) listeners.splice(index, 1) }
  }
}

test("a response is a PDF by MIME type, or by suffix only when no type was given", () => {
  assert.equal(pdfResponse("https://example.test/download", "application/pdf; version=1.7"), true)
  assert.equal(pdfResponse("https://example.test/looks-like.pdf", "text/html"), false)
  assert.equal(pdfResponse("https://example.test/paper.PDF", null), true)
  assert.equal(pdfResponse("https://example.test/page", undefined), false)
})

test("the navigation's own main-frame headers decide, without an extra request", async context => {
  const fetched = context.mock.method(globalThis, "fetch", async () => { throw new Error("no probe expected") })
  const onHeadersReceived = event()
  const watch = watchPdfSources({ webRequest: { onHeadersReceived } }, "https://example.test/document")
  assert.deepEqual(onHeadersReceived.listeners[0].filter, { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] })
  assert.deepEqual(onHeadersReceived.listeners[0].extra, ["responseHeaders"])
  const { listener } = onHeadersReceived.listeners[0]
  // A redirect's headers are not the answer; the final response's are.
  listener({ tabId: 7, statusCode: 302, url: "https://example.test/document", responseHeaders: [{ name: "Location", value: "/final" }] })
  const pending = watch.isPdf(7, new Promise(() => {}))
  listener({ tabId: 7, statusCode: 200, url: "https://example.test/final", responseHeaders: [{ name: "Content-Type", value: "application/pdf" }] })
  assert.equal(await pending, true)
  // Headers seen before the tab was asked about are remembered.
  listener({ tabId: 8, statusCode: 200, url: "https://example.test/page", responseHeaders: [{ name: "content-type", value: "text/html" }] })
  assert.equal(await watch.isPdf(8, new Promise(() => {})), false)
  assert.equal(fetched.mock.callCount(), 0)
  watch.stop()
  assert.equal(onHeadersReceived.listeners.length, 0)
})

test("a navigation whose headers were not reported falls back to a credential-less probe once it completes", async context => {
  const calls = []
  context.mock.method(globalThis, "fetch", async (_url, options) => { calls.push(options); return new Response(null, { headers: { "content-type": "application/pdf" } }) })
  const onCompleted = event()
  const watch = watchPdfSources({ webRequest: { onHeadersReceived: event() }, webNavigation: { onCompleted } }, "https://example.test/document")
  // A tab's status can read "complete" before it navigates; that alone decides nothing.
  let settled = false
  const pending = watch.isPdf(7, Promise.resolve()).then(result => { settled = true; return result })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(calls.length, 0)
  onCompleted.listeners[0].listener({ tabId: 7, frameId: 1, url: "https://example.test/frame" })
  onCompleted.listeners[0].listener({ tabId: 7, frameId: 0, url: "https://example.test/document" })
  assert.equal(await pending, true)
  assert.equal(calls[0].credentials, "omit")
  // Completion seen before the tab was asked about probes at once.
  onCompleted.listeners[0].listener({ tabId: 8, frameId: 0, url: "https://example.test/other" })
  assert.equal(await watch.isPdf(8, new Promise(() => {})), true)
  watch.stop()
  assert.equal(onCompleted.listeners.length, 0)
  // Without navigation events, the tab's load state is the last resort.
  assert.equal(await watchPdfSources({ webRequest: { onHeadersReceived: event() } }, "https://example.test/x").isPdf(9, Promise.reject(new Error("timed out"))), false)
  assert.equal(await watchPdfSources({ webRequest: { onHeadersReceived: event() } }, "https://example.test/y").isPdf(10, Promise.resolve()), true)
})

test("PDF probe falls back to GET when HEAD is unsupported and cancels the body", async context => {
  let cancelled = false
  const calls = []
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    calls.push(options.method || "GET")
    return options.method === "HEAD" ? new Response(null, { status: 405 }) : new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { "content-type": "application/pdf" } })
  })
  assert.equal(await isPdfSource("https://example.test/document"), true)
  assert.deepEqual(calls, ["HEAD", "GET"])
  assert.equal(cancelled, true)
})
