const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { installDomGlobals } = require("../../helpers/dom")
const { readAddonManifest } = require("../../../packages/core/dist")

installDomGlobals()
const directory = path.resolve(__dirname, "../../../examples/addons/nitter")
const modulePromise = import(`data:text/javascript;base64,${fs.readFileSync(path.join(directory, "main.js")).toString("base64")}`)
const fixture = (name) => fs.readFileSync(path.resolve(__dirname, "../../fixtures/collectors", name), "utf8")

const STATUS = {
  hosts: [
    { url: "https://slow-rss.test", healthy: true, rss: true, points: 50, ping_avg: 400, is_bad_host: false },
    { url: "https://html-only.test", healthy: true, rss: false, points: 99, ping_avg: 30, is_bad_host: false },
    { url: "https://best-rss.test", healthy: true, rss: true, points: 80, ping_avg: 100, is_bad_host: false },
    { url: "https://down.test", healthy: false, rss: true, points: 99, ping_avg: 10, is_bad_host: false },
    { url: "https://flagged.test", healthy: true, rss: true, points: 99, ping_avg: 10, is_bad_host: true }
  ],
  last_update: "2026-10-11T10:08:53Z"
}

async function addon({ settings = {}, stored } = {}) {
  const { createNitter } = await modulePromise
  const clock = { value: 10_000_000 }
  const log = { status: 0, stored: [], pushed: [] }
  const handlers = {}
  const once = {
    settings,
    fetch: async (url) => {
      assert.equal(url, "https://status.d420.de/api/v1/instances")
      log.status++
      return { status: 200, text: JSON.stringify(STATUS) }
    },
    storage: { get: async () => stored, set: async (key, value) => { log.stored.push([key, value]) } },
    collectors: { register: (id, value) => { handlers.collector = value } },
    redirects: { register: (id, value) => { handlers.redirect = value }, set: async (id, value) => { log.pushed.push([id, value]) } }
  }
  createNitter(once, () => clock.value)
  return { handlers, log, clock }
}

test("the manifest validates, with its dynamic redirect", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "once-addon.json"), "utf8"))
  const read = readAddonManifest({ ...manifest, script: { url: "https://bundled.test/main.js", integrity: `sha256-${"A".repeat(43)}=` } })
  assert.equal(read.ok, true, JSON.stringify(read.reports))
  assert.equal(read.manifest.redirects[0].dynamic, true)
  assert.match("https://x.com/jack/status/1", new RegExp(read.manifest.redirects[0].match))
})

test("instances are ranked healthy and unflagged, RSS first, then points", async () => {
  const { rankInstances } = await modulePromise
  assert.deepEqual(rankInstances(STATUS).map((host) => host.url), ["https://best-rss.test", "https://slow-rss.test", "https://html-only.test"])
})

test("a source resolves to the best instance's feed", async () => {
  const { handlers } = await addon()
  assert.equal(await handlers.collector.resolveUrl({ url: "https://x.com/jack", config: {} }), "https://best-rss.test/jack/rss")
  assert.equal(await handlers.collector.resolveUrl({ url: "https://twitter.com/jack", config: { replies: true } }), "https://best-rss.test/jack/with_replies/rss")
  assert.equal(await handlers.collector.resolveUrl({ url: "https://x.com/search?q=once", config: {} }), "https://best-rss.test/search/rss?f=tweets&q=once")
  await assert.rejects(handlers.collector.resolveUrl({ url: "https://x.com/home", config: {} }), /not a timeline/)
})

test("the status list is fetched once an hour at most, and never twice within its 900 s window", async () => {
  const { handlers, log, clock } = await addon()
  await handlers.redirect.target()
  await handlers.collector.resolveUrl({ url: "https://x.com/jack", config: {} })
  assert.equal(log.status, 1)
  // Every instance failing still waits out the window.
  for (const host of STATUS.hosts) await handlers.collector.failed({ fetchedUrl: `${host.url}/jack/rss`, error: "HTTP 503" })
  assert.equal(log.status, 1)
  clock.value += 900_000
  await handlers.collector.failed({ fetchedUrl: "https://best-rss.test/jack/rss", error: "HTTP 503" })
  assert.equal(log.status, 2, "after a failure, once the window passed")
  clock.value += 30 * 60_000
  await handlers.redirect.target()
  assert.equal(log.status, 2, "no failure: the hour is not up")
  clock.value += 31 * 60_000
  await handlers.redirect.target()
  assert.equal(log.status, 3)
})

test("a recent stored list spares the status page on a cold start", async () => {
  const stored = { at: 10_000_000 - 60_000, hosts: [{ url: "https://stored.test", rss: true }] }
  const { handlers, log } = await addon({ stored })
  assert.equal(await handlers.redirect.target(), "https://stored.test/$1")
  assert.equal(log.status, 0)
})

test("the synced copy is written when the list changes, never just to move its time", async () => {
  const { handlers, log, clock } = await addon()
  await handlers.redirect.target()
  assert.equal(log.stored.length, 1, "the first list is stored")
  clock.value += 61 * 60_000
  await handlers.redirect.target()
  assert.equal(log.status, 2)
  assert.equal(log.stored.length, 1, "an unchanged list is not written again")
  STATUS.hosts[1].rss = true
  try {
    clock.value += 61 * 60_000
    await handlers.redirect.target()
  } finally { STATUS.hosts[1].rss = false }
  assert.equal(log.stored.length, 2, "a changed list is")
})

test("a stored copy too old to use still spares rewriting the same list", async () => {
  const { rankInstances } = await modulePromise
  const stored = { at: 10_000_000 - 2 * 60 * 60_000, hosts: rankInstances(STATUS) }
  const { handlers, log } = await addon({ stored })
  await handlers.redirect.target()
  assert.equal(log.status, 1, "the old copy is not used")
  assert.equal(log.stored.length, 0)
})

test("a failed instance is skipped, the redirect follows, and a missing account moves nothing", async () => {
  const { handlers, log } = await addon()
  await handlers.collector.resolveUrl({ url: "https://x.com/jack", config: {} })
  assert.equal(await handlers.collector.failed({ fetchedUrl: "https://best-rss.test/nobody/rss", error: "HTTP 404: Not Found" }), false)
  assert.equal(await handlers.collector.failed({ fetchedUrl: "https://best-rss.test/jack/rss", error: "HTTP 503" }), true)
  assert.deepEqual(log.pushed, [["x-to-nitter", "https://slow-rss.test/$1"]])
  assert.equal(await handlers.collector.resolveUrl({ url: "https://x.com/jack", config: {} }), "https://slow-rss.test/jack/rss")
  assert.equal(await handlers.redirect.failed({ url: "https://slow-rss.test/jack/status/1", reason: "net::ERR_CONNECTION_RESET" }), "https://html-only.test/$1")
  assert.equal(await handlers.collector.resolveUrl({ url: "https://x.com/jack", config: {} }), "https://html-only.test/jack")
  assert.equal(await handlers.redirect.failed({ url: "https://html-only.test/jack", reason: "HTTP 502" }), null)
})

test("a pinned instance is used while it works", async () => {
  const { handlers } = await addon({ settings: { preferredInstance: "https://mine.test/" } })
  assert.equal(await handlers.redirect.target(), "https://mine.test/$1")
  assert.equal(await handlers.redirect.failed({ url: "https://mine.test/x", reason: "HTTP 503" }), "https://best-rss.test/$1")
})

test("RSS items become stories linked on x.com", async () => {
  const { parseTimeline } = await modulePromise
  const stories = parseTimeline(fixture("nitter-rss.xml"), { filterRetweets: true })
  assert.equal(stories.length, 2)
  assert.equal(stories[0].href, "https://x.com/jack/status/1840000000000000001")
  assert.equal(stories[0].title, "A useful post")
  assert.equal(stories[0].timestamp, Date.parse("2026-10-02T03:04:00Z"))
  assert.deepEqual(stories[0].tags, [{ class: "user", text: "jack", href: "https://x.com/jack" }])
  assert.equal(stories[1].tags[0].text, "alice")
  assert.equal(stories[1].filter, ":: Retweet ::")
  assert.equal(stories[0].filter, undefined)
})

test("an HTML timeline parses the same way, and a page without one is an error", async () => {
  const { parseTimeline } = await modulePromise
  const stories = parseTimeline(fixture("nitter-timeline.html"))
  assert.deepEqual(stories.map((story) => story.href), [
    "https://x.com/jack/status/1840000000000000001",
    "https://x.com/alice/status/1840000000000000002"
  ])
  assert.equal(stories[0].title, "A useful post")
  assert.equal(stories[0].tags[0].text, "jack")
  assert.equal(stories[1].filter, undefined, "retweets stay unless filtered")
  assert.throws(() => parseTimeline("<html><body>Checking your browser…</body></html>"), /did not return a timeline/)
})
