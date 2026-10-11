const test = require("node:test")
const assert = require("node:assert/strict")
const { cancelSourceDownload } = require("../../../packages/webext-shell/dist/sourceDownload")

const URL_ = "https://example.test/paper.pdf"
const since = new Date("2026-10-11T12:00:00.000Z")

function fakeDownloads(existing) {
  const calls = []
  const listeners = []
  const items = new Map(existing.map(item => [item.id, item]))
  const api = {
    onCreated: {
      addListener(listener) { listeners.push(listener) },
      removeListener(listener) { listeners.splice(listeners.indexOf(listener), 1) }
    },
    async search(query) {
      calls.push(["search", query])
      if (query.id !== undefined) return items.has(query.id) ? [items.get(query.id)] : []
      return [...items.values()].filter(item => Date.parse(item.startTime) > Date.parse(query.startedAfter))
    },
    async cancel(id) { calls.push(["cancel", id]); const item = items.get(id); if (item.state !== "complete") item.state = "interrupted" },
    async removeFile(id) { calls.push(["removeFile", id]) },
    async erase(query) { calls.push(["erase", query.id]) }
  }
  return { api, calls, listeners, items }
}

// setTimeout is mocked in these tests; the queued work settles across a few turns.
const settle = () => new Promise(resolve => setImmediate(resolve))

test("the source's download is cancelled and erased, and a finished one loses its file", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const fake = fakeDownloads([
    // Finished before the reader looked: the file is already on disk.
    { id: 1, url: URL_, startTime: "2026-10-11T12:00:00.400Z", state: "complete", exists: true },
    // The user's own earlier download of the same file stays untouched.
    { id: 2, url: URL_, startTime: "2026-10-11T11:00:00.000Z", state: "complete", exists: true },
    // Another download in the same moment is not ours.
    { id: 3, url: "https://example.test/other.pdf", startTime: "2026-10-11T12:00:00.500Z", state: "in_progress" }
  ])
  cancelSourceDownload({ downloads: fake.api }, URL_, since)
  await settle(); await settle(); await settle()
  assert.deepEqual(fake.calls.filter(([kind]) => kind !== "search"), [["cancel", 1], ["removeFile", 1], ["erase", 1]])

  // One that starts later, under its redirected URL, is caught as it is created.
  const late = { id: 4, url: "https://example.test/get?id=9", finalUrl: URL_, startTime: "2026-10-11T12:00:01.000Z", state: "in_progress" }
  fake.items.set(4, late)
  for (const listener of [...fake.listeners]) listener(late)
  for (const listener of [...fake.listeners]) listener(late)
  await settle(); await settle(); await settle()
  assert.deepEqual(fake.calls.filter(([kind, id]) => kind !== "search" && id === 4), [["cancel", 4], ["erase", 4]])

  context.mock.timers.tick(10_000)
  assert.equal(fake.listeners.length, 0)
})

test("without the downloads API nothing happens", () => {
  assert.doesNotThrow(() => cancelSourceDownload({}, URL_, since))
})
