const test = require("node:test")
const assert = require("node:assert/strict")
const {
  effectiveCacheMinutes,
  emptyCacheTimingDocument,
  readCacheTimingDocument
} = require("../../../packages/app/dist/cacheTiming")
const { SourceLoader } = require("../../../packages/app/dist/SourceLoader")
const { AppSettings } = require("../../../packages/app/dist/AppSettings")
const { DEFAULT_CACHE_MINUTES } = require("../../../packages/core/dist")

const reddit = "https://old.reddit.com/r/netsec/.json"
// An RSS feed: its collector ships no window of its own, so it inherits.
const feed = "https://example.test/stories.rss"
const timingWith = (collectors) => ({ version: 1, collectors })
// What the cache holds for a JSON collector: the decoded body, beside its stamp.
const emptyListing = () => ({ kind: "Listing", data: { children: [] } })

test("a source override beats every other layer", () => {
  const source = { id: "src_00000001", url: reddit, cacheMinutes: 7 }
  assert.equal(effectiveCacheMinutes(source, timingWith({ redditjson: 45 }), 120), 7)
})

test("a collector override beats the shipped default and the global one", () => {
  assert.equal(
    effectiveCacheMinutes(
      { id: "src_00000001", url: reddit },
      timingWith({ redditjson: 45 }),
      120
    ),
    45
  )
  assert.equal(
    effectiveCacheMinutes({ id: "src_00000002", url: feed }, timingWith({ rss: 45 }), 120),
    45
  )
})

test("a shipped collector default beats the global default", () => {
  const shipped = [[reddit, 4], ["https://old.reddit.com/r/netsec/.rss", 4],
    ["https://news.ycombinator.com/", 4], ["https://lobste.rs/", 10]]
  for (const [url, minutes] of shipped) {
    assert.equal(
      effectiveCacheMinutes({ id: "src_00000001", url }, emptyCacheTimingDocument(), 120),
      minutes,
      url
    )
  }
})

test("a collector with no opinion inherits the global default", () => {
  assert.equal(
    effectiveCacheMinutes({ id: "src_00000001", url: feed }, emptyCacheTimingDocument(), 120),
    120
  )
})

test("zero is an answer at every layer, never an absent one", () => {
  assert.equal(
    effectiveCacheMinutes(
      { id: "src_00000001", url: reddit, cacheMinutes: 0 },
      timingWith({ redditjson: 45 }),
      120
    ),
    0
  )
  assert.equal(
    effectiveCacheMinutes(
      { id: "src_00000001", url: reddit },
      timingWith({ redditjson: 0 }),
      120
    ),
    0
  )
  assert.equal(
    effectiveCacheMinutes({ id: "src_00000001", url: feed }, emptyCacheTimingDocument(), 0),
    0
  )
})

test("blank is not zero: an absent override inherits", () => {
  const source = { id: "src_00000001", url: feed, cacheMinutes: undefined }
  assert.equal(effectiveCacheMinutes(source, emptyCacheTimingDocument(), 90), 90)
})

test("out-of-range and non-integer overrides are ignored rather than clamped", () => {
  const source = { id: "src_00000001", url: feed }
  const empty = emptyCacheTimingDocument()
  assert.equal(effectiveCacheMinutes({ ...source, cacheMinutes: -5 }, empty, 120), 120)
  assert.equal(effectiveCacheMinutes({ ...source, cacheMinutes: 525_601 }, empty, 120), 120)
  assert.equal(effectiveCacheMinutes({ ...source, cacheMinutes: 5.5 }, empty, 120), 120)
  assert.equal(effectiveCacheMinutes(source, timingWith({ rss: "45" }), 120), 120)
  assert.equal(effectiveCacheMinutes(source, timingWith({ rss: -1 }), 120), 120)
})

test("an unknown collector inherits the global default", () => {
  const source = { id: "src_00000001", url: feed, collector: "no_such_collector" }
  assert.equal(effectiveCacheMinutes(source, timingWith({ rss: 45 }), 120), 120)
  const unmatched = { id: "src_00000002", url: "https://example.test/nothing" }
  assert.equal(effectiveCacheMinutes(unmatched, timingWith({ rss: 45 }), 120), 120)
})

test("an unusable global default falls back to the built-in one", () => {
  const source = { id: "src_00000001", url: feed }
  assert.equal(
    effectiveCacheMinutes(source, emptyCacheTimingDocument(), Number.NaN),
    DEFAULT_CACHE_MINUTES
  )
  assert.equal(DEFAULT_CACHE_MINUTES, 60)
})

test("the timing document is read tolerantly", () => {
  assert.deepEqual(readCacheTimingDocument(null), emptyCacheTimingDocument())
  assert.deepEqual(readCacheTimingDocument("nonsense"), emptyCacheTimingDocument())
  // A newer version holds fields this build cannot interpret.
  assert.deepEqual(
    readCacheTimingDocument({ version: 2, collectors: { redditjson: 5 } }),
    emptyCacheTimingDocument()
  )
  assert.deepEqual(
    readCacheTimingDocument({
      version: 1,
      collectors: { redditjson: 5, hackernews: "nope", future_collector: 9 }
    }),
    { version: 1, collectors: { redditjson: 5, future_collector: 9 } }
  )
})

function jsonResponse() {
  return new Response(JSON.stringify(emptyListing()), {
    status: 200,
    headers: { "content-type": "application/json" }
  })
}

function countingLoader(now, cached, respond = jsonResponse) {
  const state = { requests: 0, reads: 0, errors: [] }
  const loader = new SourceLoader(
    async () => {
      state.requests += 1
      return respond()
    },
    {
      get: async () => {
        state.reads += 1
        return cached
      },
      set: async () => {},
      delete: async () => {},
      clear: async () => {}
    },
    (error) => state.errors.push(error),
    () => now
  )
  return { loader, state }
}

const NOW = 1_700_000_000_000
const source = { id: "src_00000001", url: reddit }

test("an entry exactly N minutes old is expired", async () => {
  const exact = countingLoader(NOW, [NOW - 5 * 60_000, emptyListing()])
  await exact.loader.load(source, { policy: "cache-first", cacheMinutes: 5 })
  assert.equal(exact.state.requests, 1)

  const inside = countingLoader(NOW, [NOW - (5 * 60_000 - 1), emptyListing()])
  const stories = await inside.loader.load(source, {
    policy: "cache-first",
    cacheMinutes: 5
  })
  assert.deepEqual(stories, [])
  assert.equal(inside.state.requests, 0)
})

test("a zero window skips the cache read entirely", async () => {
  const zero = countingLoader(NOW, [NOW, emptyListing()])
  await zero.loader.load(source, { policy: "cache-first", cacheMinutes: 0 })
  assert.equal(zero.state.reads, 0)
  assert.equal(zero.state.requests, 1)
})

test("network-only leaves a fresh entry unread", async () => {
  const forced = countingLoader(NOW, [NOW, emptyListing()])
  await forced.loader.load(source, { policy: "network-only", cacheMinutes: 120 })
  assert.equal(forced.state.reads, 0)
  assert.equal(forced.state.requests, 1)
})

const failing = () => new Response("nope", { status: 503, statusText: "Down" })

test("a failed request serves an expired body, with a warning", async () => {
  const offline = countingLoader(
    NOW,
    [NOW - 3 * 60 * 60_000, emptyListing()],
    failing
  )
  const stories = await offline.loader.load(source, {
    policy: "cache-first",
    cacheMinutes: 5
  })
  assert.deepEqual(stories, [])
  assert.equal(offline.state.requests, 1)
  assert.equal(offline.state.errors.length, 1)
  assert.equal(offline.state.errors[0].type, "warning")
  assert.equal(offline.state.errors[0].title, "Offline Copy")
  assert.match(offline.state.errors[0].message, /180 minutes ago/)
})

test("a failed request with nothing cached still fails", async () => {
  const offline = countingLoader(NOW, null, failing)
  await assert.rejects(
    offline.loader.load(source, { policy: "cache-first", cacheMinutes: 5 }),
    /HTTP 503/
  )
  assert.deepEqual(offline.state.errors, [])
})

test("an unparsable cached body is no fallback", async () => {
  const offline = countingLoader(NOW, [NOW - 60_000, { kind: "nonsense" }], failing)
  await assert.rejects(
    offline.loader.load(source, { policy: "network-only", cacheMinutes: 5 }),
    /HTTP 503/
  )
  assert.deepEqual(offline.state.errors, [])
})

function settingsHarness(initial = {}) {
  const values = new Map(Object.entries(initial))
  const published = []
  const settings = new AppSettings(
    {
      get: async (id, fallback) => (values.has(id) ? values.get(id) : fallback),
      set: async (id, value) => values.set(id, structuredClone(value))
    },
    {
      getSyncUrl: async () => "",
      setSyncUrl: async () => {},
      getCacheTime: async () => 120,
      setCacheTime: async () => {}
    },
    undefined,
    { setTheme() {} },
    {
      publishChanged: (section) => published.push(section),
      reportDiagnostic() {},
      reloadStories: () => published.push("reload"),
      refilterStories() {},
      refreshRedirects() {},
      updateSourceMenu() {},
      evictRemovedSources() {},
      loadedStoryIds: () => []
    }
  )
  return { settings, values, published }
}

test("a timing change publishes cache settings without reloading stories", async () => {
  const h = settingsHarness()
  await h.settings.setCacheTiming({ version: 1, collectors: { redditjson: 4 } })
  assert.deepEqual(h.published, ["cache"])
  assert.deepEqual(h.values.get("cache_timing"), {
    version: 1,
    collectors: { redditjson: 4 }
  })

  h.settings.handleObservedChange({
    id: "cache_timing",
    doc: { list: { version: 1, collectors: { redditjson: 10 } } }
  })
  assert.deepEqual(h.published, ["cache", "cache"])
})

test("a stored timing document survives a round trip, unusable entries aside", async () => {
  const h = settingsHarness({
    cache_timing: { version: 1, collectors: { redditjson: 4, lobsters: -1 } }
  })
  assert.deepEqual(await h.settings.getCacheTiming(), {
    version: 1,
    collectors: { redditjson: 4 }
  })
})
