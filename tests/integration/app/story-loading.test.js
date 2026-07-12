const test = require("node:test")
const assert = require("node:assert/strict")
const { createOnceApp } = require("../../../packages/app/dist")
const { createFakePlatform } = require("../../helpers/fake-platform")
const { installDomGlobals } = require("../../helpers/dom")
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

test("publishes configurable parser failures as source errors", async () => {
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

test("publishes story persistence failures as source errors", async () => {
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
})
