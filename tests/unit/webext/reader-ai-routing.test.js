const test = require("node:test")
const assert = require("node:assert/strict")
const { installReaderAiRouting } = require("../../../packages/webext-shell/dist/readerAiRouting")
function event() { const listeners = new Set(); return { addListener(fn) { listeners.add(fn) }, removeListener(fn) { listeners.delete(fn) }, fire(...args) { return [...listeners].map(fn => fn(...args)) } } }

test("two panels register distinct owners; a reader receives only the owner of its window", async () => {
  const onConnect = event(), onMessage = event()
  const api = { runtime: { onConnect, onMessage, getURL: path => `chrome-extension://once${path}` } }
  const release = installReaderAiRouting(api)
  const ports = [1, 2].map(windowId => {
    const port = { name: "once-reader-ai-host", sender: { url: "chrome-extension://once/static/sidepanel.html" }, onMessage: event(), onDisconnect: event() }
    onConnect.fire(port)
    port.onMessage.fire({ owner: `${windowId}0000000-0000-4000-8000-000000000000`, windowId })
    return port
  })
  const owner = async windowId => (await Promise.all(onMessage.fire({ onceCommand: "readerAiOwner" }, { url: "https://example.test/article", tab: { id: 3, windowId } })))[0]
  assert.equal(await owner(1), "10000000-0000-4000-8000-000000000000")
  assert.equal(await owner(2), "20000000-0000-4000-8000-000000000000")
  ports[0].onDisconnect.fire()
  assert.equal(await owner(1), null)
  assert.equal(await owner(2), "20000000-0000-4000-8000-000000000000")
  release()
})

test("two panels process one formatting request once and reject duplicate or mismatched documents", async () => {
  const { installReaderAiHost } = require("../../../packages/webext-shell/dist/readerAi")
  const onConnect = event(), registrations = []
  const api = {
    runtime: { onConnect, getURL: path => `chrome-extension://once${path}`, connect: () => ({ postMessage: message => registrations.push(message) }) },
    windows: { getCurrent: async () => ({ id: 1 }) }
  }
  let calls = 0
  const client = { formatReaderAi: async () => { calls++; return { blocks: [{ id: "b0", kind: "p" }] } } }
  installReaderAiHost(client, api); installReaderAiHost(client, api)
  await new Promise(resolve => setImmediate(resolve))
  const replies = []
  const port = () => ({ name: `once-reader-ai:${registrations[0].owner}`, sender: { url: "chrome-extension://once/static/reader.html?sourceUrl=https%3A%2F%2Fexample.test%2Farticle", tab: { id: 1, windowId: 1 }, frameId: 0 }, onMessage: event(), onDisconnect: event(), postMessage: value => replies.push(value) })
  const request = { id: "request1", documentId: "document1", action: "format", sourceUrl: "https://example.test/article", blocks: [{ id: "b0", kind: "p", text: "Source words" }] }
  const first = port(); onConnect.fire(first)
  await Promise.all(first.onMessage.fire(request))
  assert.equal(calls, 1)
  assert.equal(replies.length, 1)
  const duplicate = port(); onConnect.fire(duplicate)
  await Promise.all(duplicate.onMessage.fire(request))
  assert.equal(calls, 1)
  assert.match(replies.at(-1).error, /already handled/)
  const wrong = port(); onConnect.fire(wrong)
  await Promise.all(wrong.onMessage.fire({ ...request, id: "request2", sourceUrl: "https://other.test/" }))
  assert.equal(calls, 1)
  assert.match(replies.at(-1).error, /does not match/)
})
