const test = require("node:test")
const assert = require("node:assert/strict")
const { createOnceApp } = require("../../../packages/app/dist")
const { Story } = require("../../../packages/core/dist")
const { createFakePlatform } = require("../../helpers/fake-platform")
const { installDomGlobals } = require("../../helpers/dom")
const storyFixture = require("../../e2e/shared/story-fixture")
const cachedRedditSource = require("../../fixtures/collectors/reddit.json")

installDomGlobals()

test("loads a faked story source once and reuses its cached response", async () => {
  const sourceUrl = "https://old.reddit.com/r/netsec/.json"
  let requests = 0
  const fake = createFakePlatform([], {
    storySources: [sourceUrl],
    fetch: async (url) => {
      requests += 1
      assert.equal(url, sourceUrl)
      return new Response(JSON.stringify(cachedRedditSource), { status: 200, headers: { "content-type": "application/json" } })
    }
  })
  const app = createOnceApp(fake.ports)
  const loaded = []
  app.client.subscribe("storiesChanged", ({ stories }) => loaded.push(stories))

  await app.start()
  await app.client.reloadStories("network-only")
  await app.client.reloadStories("cache-first")

  assert.equal(requests, 1)
  assert.equal(loaded.at(-1)[0].title, "Accepted Reddit story")
})

test("a configurable source now reuses its cached response too", async () => {
  // The regression this guards: configurable sources must use their fetch URL
  // as the cache key rather than any serialized representation of the source.
  const feedUrl = "https://example.com/feed.json"
  const config = {
    stories: { sel: "items", all: true },
    link: { sel: "href" },
    title: { sel: "title" }
  }
  const source = {
    id: "src_testjson1",
    url: feedUrl,
    collector: "jsonselect",
    select: config
  }
  let requests = 0
  const fake = createFakePlatform([], {
    storySources: [source],
    fetch: async (url) => {
      requests += 1
      // Fetched by the resolved URL, not by the line that carries the config.
      assert.equal(url, feedUrl)
      return new Response(
        JSON.stringify({ items: [{ href: "https://example.com/a", title: "Configured story" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    }
  })
  const app = createOnceApp(fake.ports)
  const loaded = []
  app.client.subscribe("storiesChanged", ({ stories }) => loaded.push(stories))

  await app.start()
  await app.client.reloadStories("network-only")
  await app.client.reloadStories("cache-first")

  assert.equal(requests, 1, "the second reload must come from cache")
  assert.equal(loaded.at(-1)[0].title, "Configured story")
})

test("registers stored source stories before synchronized updates arrive", async () => {
  const sourceUrl = "https://old.reddit.com/r/netsec/.json"
  const stored = new Story(
    "reddit",
    "https://example.com/reddit",
    "Previously stored story"
  )
  stored._rev = "6-stored"
  const fake = createFakePlatform([stored], {
    storySources: [sourceUrl],
    fetch: async () =>
      new Response(JSON.stringify(cachedRedditSource), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  })
  const app = createOnceApp(fake.ports)
  const changes = []
  app.client.subscribe("storyChanged", (change) => changes.push(change))

  await app.start()
  await app.client.reloadStories("network-only")

  assert.equal(app.client.getStorySnapshot()[0]._rev, "6-stored")

  fake.emitRemoteDatabaseChange({
    id: `sto_${stored.href}`,
    doc: {
      ...stored.to_obj(),
      _rev: "7-remote",
      read_state: "skipped",
      sync_updated_at: { read_state: 200 }
    },
    presentation: "foreground"
  })
  await app.client.settledStoryWrites()

  assert.equal(app.client.getStorySnapshot()[0].read_state, "skipped")
  assert.equal(changes.at(-1).story.read_state, "skipped")
  assert.deepEqual(changes.at(-1).path, [stored.href])
})

test("includes stared stories outside the bounded working set", async () => {
  const stored = Array.from({ length: 501 }, (_, index) =>
    new Story("rss", `https://example.com/${index}`, `Story ${index}`)
  )
  stored[500].stared = true
  const app = createOnceApp(createFakePlatform(stored).ports)

  await app.start()
  const stories = await app.client.getStories()

  assert.equal(stories.length, 501)
  assert.equal(stories.some((story) => story.href === stored[500].href), true)
})

test("includes stored stared stories when a source fills the visible list", async () => {
  const sourceUrl = "https://old.reddit.com/r/netsec/.json"
  const stared = new Story(
    "rss",
    "https://example.com/old-stared",
    "Old stared story"
  )
  stared.stared = true
  const fake = createFakePlatform([stared], {
    storySources: [sourceUrl],
    fetch: async () =>
      new Response(JSON.stringify(cachedRedditSource), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  })
  const app = createOnceApp(fake.ports)
  const batches = []
  app.client.subscribe("storiesChanged", ({ stories }) => batches.push(stories))

  await app.start()
  await app.client.reloadStories("network-only")

  assert.equal(
    batches.at(-1).some((story) => story.href === stared.href),
    true
  )
})

test("loads a saved source once when PouchDB echoes the local setting change", async () => {
  const sourceUrl = "https://old.reddit.com/r/netsec/.json"
  let requests = 0
  const fake = createFakePlatform([], {
    emitDatabaseChangesOnSet: true,
    fetch: async (url) => {
      requests += 1
      assert.equal(url, sourceUrl)
      return new Response(JSON.stringify(cachedRedditSource), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }
  })
  const app = createOnceApp(fake.ports)

  await app.start()
  await app.client.saveStorySources({ version: 2, groups: [], sources: [
    { id: "src_00000001", url: sourceUrl }
  ] })

  assert.equal(requests, 1)
})

test("serializes duplicate story writes while preserving substories", async () => {
  const origin = "https://fixture.example"
  const sourceDocument = JSON.parse(storyFixture.sourceLine(origin))
  const fake = createFakePlatform([], {
    storySources: sourceDocument,
    fetch: async (url) => {
      assert.equal(url, `${origin}/feed.json`)
      return new Response(JSON.stringify(storyFixture.feedJson(origin)), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }
  })
  const saveStory = fake.ports.storyStore.saveStory
  const writes = new Set()
  fake.ports.storyStore.saveStory = async (story) => {
    assert.equal(
      writes.has(story.href),
      false,
      `concurrent write for ${story.href}`
    )
    writes.add(story.href)
    try {
      await new Promise((resolve) => setImmediate(resolve))
      return await saveStory(story)
    } finally {
      writes.delete(story.href)
    }
  }
  const app = createOnceApp(fake.ports)
  const batches = []
  app.client.subscribe("storiesChanged", ({ stories }) => {
    batches.push(stories)
  })

  await app.start()
  await app.client.reloadStories("network-only")

  const beta = batches.at(-1).find(
    (story) => story.href === storyFixture.storyUrls(origin).beta
  )
  assert.equal(beta.substories.length, 1)
  assert.equal(beta.substories[0].comment_url, storyFixture.storyUrls(origin).betaSubstoryComments)
})

test("publishes configurable parser failures as source errors", async (t) => {
  t.mock.method(console, "error", () => {})

  const sourceUrl = "https://example.com/"
  const fake = createFakePlatform([], {
    storySources: [],
    fetch: async () => new Response("<main></main>", { status: 200 })
  })
  const app = createOnceApp(fake.ports)
  const sourceErrors = []
  app.client.subscribe("sourceErrorsChanged", ({ errors }) => {
    sourceErrors.push(errors)
  })

  await app.start()
  await app.client.saveStorySources({ version: 2, groups: [], sources: [{
    id: "src_00000001", url: sourceUrl, collector: "geny", select: { bad: true }
  }] }, false)
  await app.client.reloadStories("network-only")

  // Caught while resolving the source now, so no request is made at all — this
  // used to be fetched first and then fail in the DOM parser.
  const error = sourceErrors.at(-1)[0]
  assert.equal(error.title, "Config Error")
  assert.match(error.message, /known field|missing stories/)
})

test("publishes story persistence failures as source errors", async (t) => {
  t.mock.method(console, "error", () => {})

  const sourceUrl = "https://old.reddit.com/r/netsec/.json"
  const fake = createFakePlatform([], {
    storySources: [sourceUrl],
    fetch: async () =>
      new Response(JSON.stringify(cachedRedditSource), { status: 200 })
  })
  fake.ports.storyStore.saveStory = async () => {
    throw new Error("disk full")
  }
  const app = createOnceApp(fake.ports)
  const sourceErrors = []
  app.client.subscribe("sourceErrorsChanged", ({ errors }) => {
    sourceErrors.push(errors)
  })

  await app.start()
  await app.client.reloadStories("network-only")

  const error = sourceErrors.at(-1)[0]
  assert.equal(error.title, "Failed")
  assert.match(error.message, /disk full/)
  const diagnostic = app.client
    .getDiagnostics()
    .find((entry) => entry.operation === "story.save")
  assert.ok(diagnostic)
  assert.equal(diagnostic.storyUrl, "https://example.com/reddit")
  assert.match(diagnostic.details, /disk full/)
})

test("disabled sources are neither loaded nor exposed through the menu", async () => {
  let requests = 0
  const fake = createFakePlatform([], { fetch: async () => {
    requests += 1
    return new Response("", { status: 200 })
  } })
  const app = createOnceApp(fake.ports)
  const menus = []
  app.client.subscribe("menuChanged", (menu) => menus.push(menu))
  await app.start()
  await app.client.saveStorySources({
    version: 2,
    groups: [{ id: "grp_00000001", name: "Disabled" }],
    sources: [{ id: "src_00000001", url: "https://news.ycombinator.com/",
      groupId: "grp_00000001", enabled: false }]
  })
  assert.equal(requests, 0)
  assert.equal(menus.at(-1).groups.includes("Disabled"), false)
  assert.equal(menus.at(-1).types.includes("HN"), false)
})

test("the shipped collector window expires a body the global default would serve", async () => {
  const sourceUrl = "https://old.reddit.com/r/netsec/.json"
  let requests = 0
  const fake = createFakePlatform([], {
    storySources: [sourceUrl],
    cachedResponses: [[sourceUrl, [Date.now() - 10 * 60 * 1000, cachedRedditSource]]],
    cacheTime: 120,
    fetch: async () => {
      requests += 1
      return new Response(JSON.stringify(cachedRedditSource), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }
  })
  const app = createOnceApp(fake.ports)

  await app.start()
  // Ten minutes old. The global default would still serve it; Reddit's own
  // four-minute window is what sends this back to the network.
  await app.client.reloadStories("cache-first")
  assert.equal(requests, 1)
})

test("a user collector override outranks the shipped window", async () => {
  const sourceUrl = "https://old.reddit.com/r/netsec/.json"
  let requests = 0
  const fake = createFakePlatform([], {
    storySources: [sourceUrl],
    cachedResponses: [[sourceUrl, [Date.now() - 10 * 60 * 1000, cachedRedditSource]]],
    fetch: async () => {
      requests += 1
      return new Response(JSON.stringify(cachedRedditSource), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }
  })
  const app = createOnceApp(fake.ports)

  await app.start()
  await app.client.setCacheTiming({ version: 1, collectors: { redditjson: 60 } })
  await app.client.reloadStories("cache-first")
  assert.equal(requests, 0, "an hour-long override keeps the ten-minute body")
})

test("a source override beats the collector override", async () => {
  const sourceUrl = "https://old.reddit.com/r/netsec/.json"
  let requests = 0
  const fake = createFakePlatform([], {
    storySources: [{ id: "src_testcache1", url: sourceUrl, cacheMinutes: 60 }],
    cachedResponses: [[sourceUrl, [Date.now() - 10 * 60 * 1000, cachedRedditSource]]],
    fetch: async () => {
      requests += 1
      return new Response(JSON.stringify(cachedRedditSource), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }
  })
  const app = createOnceApp(fake.ports)

  await app.start()
  await app.client.setCacheTiming({ version: 1, collectors: { redditjson: 5 } })
  await app.client.reloadStories("cache-first")
  assert.equal(requests, 0, "the source's own hour-long window applies")
})

test("a zero window always refetches, whichever layer sets it", async () => {
  const sourceUrl = "https://old.reddit.com/r/netsec/.json"
  let requests = 0
  const fake = createFakePlatform([], {
    storySources: [{ id: "src_testcache2", url: sourceUrl, cacheMinutes: 0 }],
    // Written a moment ago, so nothing but a zero window would refetch it.
    cachedResponses: [[sourceUrl, [Date.now(), cachedRedditSource]]],
    fetch: async () => {
      requests += 1
      return new Response(JSON.stringify(cachedRedditSource), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }
  })
  const app = createOnceApp(fake.ports)

  await app.start()
  await app.client.reloadStories("cache-first")
  assert.equal(requests, 1)
})

test("a failed request falls back to the cached copy and warns", async () => {
  const sourceUrl = "https://old.reddit.com/r/netsec/.json"
  const fake = createFakePlatform([], {
    storySources: [sourceUrl],
    // Far outside any window, so only the fallback can produce a story.
    cachedResponses: [[sourceUrl, [Date.now() - 24 * 60 * 60 * 1000, cachedRedditSource]]],
    fetch: async () => {
      throw new TypeError("Failed to fetch")
    }
  })
  const app = createOnceApp(fake.ports)
  const errors = []
  const loaded = []
  app.client.subscribe("sourceErrorsChanged", ({ errors: list }) => errors.push(list))
  app.client.subscribe("storiesChanged", ({ stories }) => loaded.push(stories))

  await app.start()
  await app.client.reloadStories("cache-first")

  assert.equal(loaded.at(-1)[0].title, "Accepted Reddit story")
  const warning = errors.at(-1).find((error) => error.title === "Offline Copy")
  assert.ok(warning, "the stale copy must be reported")
  assert.equal(warning.type, "warning")
})

test("refetching one source forces it and leaves the others alone", async () => {
  const first = "https://old.reddit.com/r/netsec/.json"
  const second = "https://old.reddit.com/r/programming/.json"
  const requests = new Map()
  const fresh = Date.now()
  const fake = createFakePlatform([], {
    storySources: [
      { id: "src_testfirst", url: first },
      { id: "src_testsecond", url: second }
    ],
    cachedResponses: [
      [first, [fresh, cachedRedditSource]],
      [second, [fresh, cachedRedditSource]]
    ],
    fetch: async (url) => {
      requests.set(url, (requests.get(url) || 0) + 1)
      return new Response(JSON.stringify(cachedRedditSource), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }
  })
  const app = createOnceApp(fake.ports)

  await app.start()
  await app.client.reloadStories("cache-first")
  assert.equal(requests.size, 0, "both bodies are fresh")

  await app.client.refetchSource("src_testfirst")
  assert.deepEqual([...requests.entries()], [[first, 1]])
  assert.ok(fake.cachedResponses.has(second), "a shared or sibling entry survives")
})

test("clearing cached feeds sends the next reload back to the network", async () => {
  const sourceUrl = "https://old.reddit.com/r/netsec/.json"
  let requests = 0
  const fake = createFakePlatform([], {
    storySources: [sourceUrl],
    cachedResponses: [[sourceUrl, [Date.now(), cachedRedditSource]]],
    fetch: async () => {
      requests += 1
      return new Response(JSON.stringify(cachedRedditSource), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }
  })
  const app = createOnceApp(fake.ports)

  await app.start()
  await app.client.reloadStories("cache-first")
  assert.equal(requests, 0)

  await app.client.clearCachedFeeds()
  assert.equal(fake.cachedResponses.size, 0)
  await app.client.reloadStories("cache-first")
  assert.equal(requests, 1)
})

test("deleting a source evicts its body unless another source shares it", async () => {
  const shared = "https://old.reddit.com/r/netsec/.json"
  const lonely = "https://old.reddit.com/r/programming/.json"
  const sources = [
    { id: "src_testshared1", url: shared },
    { id: "src_testshared2", url: shared },
    { id: "src_testlonely1", url: lonely }
  ]
  const fake = createFakePlatform([], {
    storySources: sources,
    cachedResponses: [
      [shared, [Date.now(), cachedRedditSource]],
      [lonely, [Date.now(), cachedRedditSource]]
    ],
    fetch: async () => new Response(JSON.stringify(cachedRedditSource), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  })
  const app = createOnceApp(fake.ports)

  await app.start()
  await app.client.saveStorySources(
    { version: 2, groups: [], sources: [sources[1]] },
    false
  )

  assert.ok(fake.cachedResponses.has(shared), "the surviving source still uses it")
  assert.equal(fake.cachedResponses.has(lonely), false)
})

test("cache status reports each source's window and last fetch", async () => {
  const sourceUrl = "https://old.reddit.com/r/netsec/.json"
  const fetchedAt = Date.now() - 60_000
  const fake = createFakePlatform([], {
    storySources: [
      { id: "src_teststatus1", url: sourceUrl, label: "Netsec" },
      { id: "src_teststatus2", url: "https://lobste.rs/", cacheMinutes: 30 }
    ],
    cachedResponses: [[sourceUrl, [fetchedAt, cachedRedditSource]]],
    fetch: async () => new Response(JSON.stringify(cachedRedditSource), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  })
  const app = createOnceApp(fake.ports)

  await app.start()
  const status = await app.client.getSourceCacheStatus()

  assert.deepEqual(status.map((row) => row.name), ["Netsec", "lobste.rs"])
  assert.deepEqual(status.map((row) => row.cacheMinutes), [4, 30])
  assert.deepEqual(status.map((row) => row.ownWindow), [false, true])
  assert.equal(status[0].fetchedAt, fetchedAt)
  assert.equal(status[1].fetchedAt, undefined, "nothing cached yet")
})
