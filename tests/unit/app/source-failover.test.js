const test = require("node:test")
const assert = require("node:assert/strict")
const { SourceLoader } = require("../../../packages/app/dist/SourceLoader")
const { registerCollector } = require("../../../packages/collectors/dist/registry")

// A collector that fetches from mirrors it picks, the way the Nitter add-on does.
function mirrorCollector(mirrors, calls) {
  let current = 0
  return registerCollector({
    options: { id: "addon:mirrors/feed", type: "MX", description: "Mirrored", pattern: ["https://origin.test/"], collects: "json", colors: ["#123456", "white"] },
    parse: () => { throw new Error("parses in its sandbox") },
    parseBody: async (body) => [{ href: body.href, title: "From " + body.mirror, type: "MX", tags: [] }],
    fetchTarget: {
      resolve: async () => mirrors[current] ?? null,
      failed: async (context) => {
        calls.push(context)
        current += 1
        return current < mirrors.length
      }
    }
  })
}

function loader(respond) {
  const state = { fetched: [], inits: [], cached: [] }
  const instance = new SourceLoader(
    async (url, init) => {
      state.fetched.push(url)
      state.inits.push(init)
      return respond(url)
    },
    {
      get: async () => null,
      set: async (key) => { state.cached.push(key) },
      delete: async () => {},
      clear: async () => {}
    },
    () => {}
  )
  return { instance, state }
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
const source = { id: "src_00000001", url: "https://origin.test/feed" }

test("a collector's chosen mirror is fetched without credentials, and cached under the source", async (t) => {
  const calls = []
  t.after(mirrorCollector(["https://a.test/feed"], calls))
  const { instance, state } = loader(() => json({ href: "https://origin.test/1", mirror: "a" }))
  const stories = await instance.load(source, { policy: "network-only", cacheMinutes: 5 })
  assert.equal(stories[0].title, "From a")
  assert.deepEqual(state.fetched, ["https://a.test/feed"])
  assert.equal(state.inits[0].credentials, "omit")
  assert.deepEqual(state.cached, ["https://origin.test/feed"])
  assert.deepEqual(calls, [])
})

test("a failed mirror is reported and the next one is tried", async (t) => {
  const calls = []
  t.after(mirrorCollector(["https://a.test/feed", "https://b.test/feed"], calls))
  const { instance, state } = loader((url) => url.startsWith("https://a.test")
    ? new Response("down", { status: 503, statusText: "Down" })
    : json({ href: "https://origin.test/1", mirror: "b" }))
  const stories = await instance.load(source, { policy: "network-only", cacheMinutes: 5 })
  assert.equal(stories[0].title, "From b")
  assert.deepEqual(state.fetched, ["https://a.test/feed", "https://b.test/feed"])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].fetchedUrl, "https://a.test/feed")
  assert.match(calls[0].error, /HTTP 503/)
})

test("failover gives up after two further mirrors", async (t) => {
  const calls = []
  t.after(mirrorCollector(["https://a.test/", "https://b.test/", "https://c.test/", "https://d.test/"], calls))
  const { instance, state } = loader(() => new Response("down", { status: 502, statusText: "Bad Gateway" }))
  await assert.rejects(instance.load(source, { policy: "network-only", cacheMinutes: 5 }), /HTTP 502/)
  assert.equal(state.fetched.length, 3)
})
