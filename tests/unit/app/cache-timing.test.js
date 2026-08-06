const test = require("node:test")
const assert = require("node:assert/strict")
const {
  effectiveCacheMinutes,
  emptyCacheTimingDocument,
  readCacheTimingDocument
} = require("../../../packages/app/dist/cacheTiming")
const { SourceLoader } = require("../../../packages/app/dist/SourceLoader")
const { AppSettings } = require("../../../packages/app/dist/AppSettings")

const reddit = "https://old.reddit.com/r/netsec/.json"
const timingWith = (collectors) => ({ version: 1, collectors })
// What the cache holds for a JSON collector: the decoded body, beside its stamp.
const emptyListing = () => ({ kind: "Listing", data: { children: [] } })

test("a source override beats every other layer", () => {
  const source = { id: "src_00000001", url: reddit, cacheMinutes: 7 }
  const timing = timingWith({ redditjson: 45 })
  assert.equal(effectiveCacheMinutes(source, timing, 120), 7)
})

test("a collector override beats the global default", () => {
  const source = { id: "src_00000001", url: reddit }
  assert.equal(
    effectiveCacheMinutes(source, timingWith({ redditjson: 45 }), 120),
    45
  )
})

test("no override anywhere inherits the global default", () => {
  const source = { id: "src_00000001", url: reddit }
  assert.equal(
    effectiveCacheMinutes(source, emptyCacheTimingDocument(), 120),
    120
  )
})

test("zero is an answer at every layer, never an absent one", () => {
  const url = reddit
  assert.equal(
    effectiveCacheMinutes(
      { id: "src_00000001", url, cacheMinutes: 0 },
      timingWith({ redditjson: 45 }),
      120
    ),
    0
  )
  assert.equal(
    effectiveCacheMinutes(
      { id: "src_00000001", url },
      timingWith({ redditjson: 0 }),
      120
    ),
    0
  )
  assert.equal(
    effectiveCacheMinutes({ id: "src_00000001", url }, emptyCacheTimingDocument(), 0),
    0
  )
})

test("blank is not zero: an absent override inherits", () => {
  const source = { id: "src_00000001", url: reddit, cacheMinutes: undefined }
  assert.equal(
    effectiveCacheMinutes(source, emptyCacheTimingDocument(), 90),
    90
  )
})

test("out-of-range and non-integer overrides are ignored rather than clamped", () => {
  const source = { id: "src_00000001", url: reddit }
  assert.equal(
    effectiveCacheMinutes({ ...source, cacheMinutes: -5 }, emptyCacheTimingDocument(), 120),
    120
  )
  assert.equal(
    effectiveCacheMinutes({ ...source, cacheMinutes: 525_601 }, emptyCacheTimingDocument(), 120),
    120
  )
  assert.equal(
    effectiveCacheMinutes({ ...source, cacheMinutes: 5.5 }, emptyCacheTimingDocument(), 120),
    120
  )
  assert.equal(effectiveCacheMinutes(source, timingWith({ redditjson: "45" }), 120), 120)
  assert.equal(effectiveCacheMinutes(source, timingWith({ redditjson: -1 }), 120), 120)
})

test("an unknown collector inherits the global default", () => {
  const source = { id: "src_00000001", url: reddit, collector: "no_such_collector" }
  assert.equal(
    effectiveCacheMinutes(source, timingWith({ redditjson: 45 }), 120),
    120
  )
  const unmatched = { id: "src_00000002", url: "https://example.test/feed" }
  assert.equal(
    effectiveCacheMinutes(unmatched, timingWith({ redditjson: 45 }), 120),
    120
  )
})

test("an unusable global default falls back to 120 minutes", () => {
  const source = { id: "src_00000001", url: reddit }
  assert.equal(
    effectiveCacheMinutes(source, emptyCacheTimingDocument(), Number.NaN),
    120
  )
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

function boundaryLoader(ageMs, now) {
  let requests = 0
  const loader = new SourceLoader(
    async () => {
      requests += 1
      return new Response("missing", { status: 404, statusText: "Not Found" })
    },
    { get: async () => [now - ageMs, emptyListing()], set: async () => {} },
    () => {},
    () => now
  )
  return { loader, requests: () => requests }
}

test("an entry exactly N minutes old is expired", async () => {
  const now = 1_700_000_000_000
  const source = { id: "src_00000001", url: reddit }

  const exact = boundaryLoader(5 * 60_000, now)
  await assert.rejects(
    exact.loader.load(source, { policy: "cache-first", cacheMinutes: 5 }),
    /HTTP 404/
  )
  assert.equal(exact.requests(), 1)

  const inside = boundaryLoader(5 * 60_000 - 1, now)
  const stories = await inside.loader.load(source, {
    policy: "cache-first",
    cacheMinutes: 5
  })
  assert.deepEqual(stories, [])
  assert.equal(inside.requests(), 0)
})

test("a zero window skips the cache read entirely", async () => {
  const now = 1_700_000_000_000
  let reads = 0
  let requests = 0
  const loader = new SourceLoader(
    async () => {
      requests += 1
      return new Response("missing", { status: 404, statusText: "Not Found" })
    },
    {
      get: async () => {
        reads += 1
        return [now, emptyListing()]
      },
      set: async () => {}
    },
    () => {},
    () => now
  )

  await assert.rejects(
    loader.load(
      { id: "src_00000001", url: reddit },
      { policy: "cache-first", cacheMinutes: 0 }
    ),
    /HTTP 404/
  )
  assert.equal(reads, 0)
  assert.equal(requests, 1)
})

test("network-only leaves a fresh entry unread", async () => {
  const now = 1_700_000_000_000
  let reads = 0
  let requests = 0
  const loader = new SourceLoader(
    async () => {
      requests += 1
      return new Response("missing", { status: 404, statusText: "Not Found" })
    },
    {
      get: async () => {
        reads += 1
        return [now, emptyListing()]
      },
      set: async () => {}
    },
    () => {},
    () => now
  )

  await assert.rejects(
    loader.load(
      { id: "src_00000001", url: reddit },
      { policy: "network-only", cacheMinutes: 120 }
    ),
    /HTTP 404/
  )
  assert.equal(reads, 0)
  assert.equal(requests, 1)
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
