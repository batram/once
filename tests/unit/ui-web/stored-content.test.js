const test = require("node:test")
const assert = require("node:assert/strict")
const { StoredContentSaver, installStoredContentSaver } = require(
  "../../../packages/ui-web/dist/reader/storedContent"
)

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test("saves a few pages at a time, each requested URL once", async () => {
  const started = []
  const gates = new Map()
  const saver = new StoredContentSaver({}, {
    concurrency: 2,
    save: async (_client, href) => {
      started.push(href)
      const gate = deferred()
      gates.set(href, gate)
      await gate.promise
    }
  })
  saver.request("https://a.test/1")
  saver.request("https://a.test/2")
  saver.request("https://a.test/3")
  saver.request("https://a.test/1")
  assert.deepEqual(started, ["https://a.test/1", "https://a.test/2"], "the third waits its turn")

  gates.get("https://a.test/1").resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(started, ["https://a.test/1", "https://a.test/2", "https://a.test/3"])
  // Asked again while still running: not queued twice.
  saver.request("https://a.test/2")
  gates.get("https://a.test/2").resolve()
  gates.get("https://a.test/3").resolve()
  await saver.settled()
  assert.equal(started.length, 3)
  // Finished ones may be asked for again later.
  saver.request("https://a.test/1")
  gates.get("https://a.test/1").resolve()
  await saver.settled()
  assert.equal(started.length, 4)
})

test("a failure is reported once and does not stop the queue", async () => {
  const reported = []
  const saver = new StoredContentSaver({}, {
    concurrency: 1,
    reportError: (message, details) => reported.push({ message, details }),
    save: async (_client, href) => {
      if (href.endsWith("/bad")) throw new Error("HTTP 500")
    }
  })
  saver.request("https://a.test/bad")
  saver.request("https://a.test/good")
  await saver.settled()
  assert.equal(reported.length, 1)
  assert.match(reported[0].message, /could not be saved for offline: HTTP 500/)
  assert.match(reported[0].details, /Story: https:\/\/a.test\/bad/)
})

test("serves the app's requests and extracts through the client", async () => {
  const handlers = new Map()
  const saved = []
  const client = {
    subscribe(event, handler) { handlers.set(event, handler); return () => handlers.delete(event) },
    async fetchDocument() { throw new Error("not used: extraction is injected here") },
    async saveStoryContent(href, html, meta) { saved.push({ href, html, meta }) }
  }
  const saver = installStoredContentSaver(client, {
    save: async (aClient, href) => aClient.saveStoryContent(href, "<p>x</p>", { source: "page" })
  })
  handlers.get("storyContentRequested")({ href: "https://a.test/1" })
  await saver.settled()
  assert.deepEqual(saved, [{ href: "https://a.test/1", html: "<p>x</p>", meta: { source: "page" } }])
})
