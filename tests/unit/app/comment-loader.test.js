const test = require("node:test")
const assert = require("node:assert/strict")
const { CommentLoader } = require("../../../packages/app/dist/CommentLoader")
const story = require("../../fixtures/collectors/comments/lobsters-story.json")

const URL_A = "https://lobste.rs/s/rb2ulg/title"

function countingFetch(respond = () => new Response(JSON.stringify(story), { status: 200 })) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return respond(url)
  }
  return { fetch, calls }
}

test("knows which comment URLs a collector can read", () => {
  const loader = new CommentLoader(async () => new Response(""))
  assert.equal(loader.canLoad(URL_A), true)
  assert.equal(loader.canLoad("https://example.com/comments"), false)
  assert.equal(loader.canLoad("javascript:alert(1)"), false)
})

test("loads through the shell's fetch, with a timeout signal", async () => {
  const { fetch, calls } = countingFetch()
  const thread = await new CommentLoader(fetch).load(URL_A)
  assert.equal(thread.provider, "lobsters")
  assert.equal(calls.length, 1)
  assert.ok(calls[0].init.signal instanceof AbortSignal)
})

test("serves a recent thread from memory until it goes stale or a refresh asks", async () => {
  let now = 0
  const { fetch, calls } = countingFetch()
  const loader = new CommentLoader(fetch, () => now)
  await loader.load(URL_A)
  await loader.load(URL_A)
  assert.equal(calls.length, 1)
  await loader.load(URL_A, { refresh: true })
  assert.equal(calls.length, 2)
  now += 6 * 60_000
  await loader.load(URL_A)
  assert.equal(calls.length, 3)
})

test("does not keep a failure", async () => {
  let fail = true
  const { fetch, calls } = countingFetch(() => fail
    ? new Response("down", { status: 503 })
    : new Response(JSON.stringify(story), { status: 200 }))
  const loader = new CommentLoader(fetch)
  await assert.rejects(loader.load(URL_A), /503/)
  fail = false
  const thread = await loader.load(URL_A)
  assert.equal(thread.provider, "lobsters")
  assert.equal(calls.length, 2)
})

test("refuses a URL no collector reads", async () => {
  await assert.rejects(new CommentLoader(async () => new Response("")).load("https://example.com/x"), /No collector/)
})
