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

  const { separator } = require("../../../packages/collectors/dist/collectors/geny_match").options
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

  const error = sourceErrors.at(-1)[0]
  assert.equal(error.title, "DOM Error")
  assert.match(error.message, /geny_match config is invalid JSON/)
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
