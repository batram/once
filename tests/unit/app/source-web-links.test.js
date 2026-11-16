const test = require("node:test")
const assert = require("node:assert/strict")
const { SourceLoader } = require("../../../packages/app/dist/SourceLoader")
const { registerCollector } = require("../../../packages/collectors/dist/registry")

// A feed chooses every link in what it returns. Whatever the collector made of
// them, the loader hands on only stories that link to the web.
const EXTENSION_PAGE = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/static/addon-conversation.html?run=addon:wwww/explain&href=https://victim.test/"
const source = { id: "src_00000001", url: "https://origin.test/feed" }
const body = {
  items: [
    { href: EXTENSION_PAGE, title: "Hostile", type: "LX", comment_url: "", tags: [] },
    { href: "/static/addon-conversation.html?run=x", title: "Relative", type: "LX", comment_url: "javascript:alert(1)", tags: [] },
    { href: "https://origin.test/1", title: "Plain", type: "LX", comment_url: EXTENSION_PAGE, tags: [{ class: "user", text: "feed", href: EXTENSION_PAGE }] }
  ]
}

function collector() {
  return registerCollector({
    options: { id: "addon:links/feed", type: "LX", description: "Links", pattern: ["https://origin.test/"], collects: "json", colors: ["#123456", "white"] },
    parse: () => { throw new Error("parses in its sandbox") },
    parseBody: async (value) => value.items.map(item => ({ ...item, tags: item.tags.map(tag => ({ ...tag })) }))
  })
}

function check(stories) {
  assert.deepEqual(stories.map(story => story.href), ["https://origin.test/static/addon-conversation.html?run=x", "https://origin.test/1"])
  assert.equal(stories[0].comment_url, "")
  assert.equal(stories[1].comment_url, "")
  assert.deepEqual(stories[1].tags, [{ class: "user", text: "feed" }])
}

test("a fetched feed's links off the web never reach the story list", async (t) => {
  t.after(collector())
  const loader = new SourceLoader(
    async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    { get: async () => null, set: async () => {}, delete: async () => {}, clear: async () => {} },
    () => {}
  )
  check(await loader.load(source, { policy: "network-only", cacheMinutes: 5 }))
})

test("a cached feed body is held to the same rule", async (t) => {
  t.after(collector())
  const loader = new SourceLoader(
    async () => { throw new Error("the cache answers") },
    { get: async () => [Date.now(), body], set: async () => {}, delete: async () => {}, clear: async () => {} },
    () => {}
  )
  check(await loader.load(source, { policy: "cache-first", cacheMinutes: 5 }))
})
