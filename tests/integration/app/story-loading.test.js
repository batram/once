const test = require("node:test")
const assert = require("node:assert/strict")
const { createOnceApp } = require("../../../packages/app/dist")
const { createFakePlatform } = require("../../helpers/fake-platform")
const cachedRedditSource = require("../../fixtures/collectors/reddit.json")

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
