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
  await app.client.reloadStories(false)
  await app.client.reloadStories(true)

  assert.equal(requests, 1)
  assert.equal(loaded.at(-1)[0].title, "Accepted Reddit story")
})

test("a configurable source now reuses its cached response too", async () => {
  // The regression this guards: the cache was read under the whole source line
  // but written under the resolved URL, so a json:/geny: source refetched on
  // every single reload no matter what the cache setting said. Before the
  // resolver landed, this asked for two requests and got two.
  const {
    LEGACY_SEPARATOR: separator
  } = require("../../../packages/core/dist/settings/legacySourceLines")
  const feedUrl = "https://example.com/feed.json"
  const config = {
    stories: { sel: "items", all: true },
    link: { sel: "href" },
    title: { sel: "title" }
  }
  const sourceUrl = `json:${separator}${JSON.stringify(config)}${separator}${feedUrl}`
  let requests = 0
  const fake = createFakePlatform([], {
    storySources: [sourceUrl],
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
  await app.client.reloadStories(false)
  await app.client.reloadStories(true)

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
  await app.client.reloadStories(false)

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
  await app.client.reloadStories(false)

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
  await app.client.saveStorySources([sourceUrl])

  assert.equal(requests, 1)
})

test("serializes duplicate story writes while preserving substories", async () => {
  const origin = "https://fixture.example"
  const sourceUrl = storyFixture.sourceLine(origin)
  const fake = createFakePlatform([], {
    storySources: [sourceUrl],
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
  await app.client.reloadStories(false)

  const beta = batches.at(-1).find(
    (story) => story.href === storyFixture.storyUrls(origin).beta
  )
  assert.equal(beta.substories.length, 1)
  assert.equal(beta.substories[0].comment_url, storyFixture.storyUrls(origin).betaSubstoryComments)
})

test("publishes configurable parser failures as source errors", async (t) => {
  t.mock.method(console, "error", () => {})

  const {
    LEGACY_SEPARATOR: separator
  } = require("../../../packages/core/dist/settings/legacySourceLines")
  const sourceUrl = `geny:${separator}{bad${separator}https://example.com/`
  const fake = createFakePlatform([], {
    storySources: [sourceUrl],
    fetch: async () => new Response("<main></main>", { status: 200 })
  })
  const app = createOnceApp(fake.ports)
  const sourceErrors = []
  app.client.subscribe("sourceErrorsChanged", ({ errors }) => {
    sourceErrors.push(errors)
  })

  await app.start()
  await app.client.reloadStories(false)

  // Caught while resolving the source now, so no request is made at all — this
  // used to be fetched first and then fail in the DOM parser.
  const error = sourceErrors.at(-1)[0]
  assert.equal(error.title, "Config Error")
  assert.match(error.message, /unreadable selector configuration/)
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
  await app.client.reloadStories(false)

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
