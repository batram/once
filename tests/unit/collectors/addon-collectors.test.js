const test = require("node:test")
const assert = require("node:assert/strict")
const { Story } = require("../../../packages/core/dist/index")
const {
  get_active,
  get_parser_by_id,
  get_parser_for_url,
  parse_response,
  registerCollector,
  resolveStorySource
} = require("../../../packages/collectors/dist/index")

const addonParser = (overrides = {}) => ({
  options: {
    id: "addon:demo/json",
    type: "DJ",
    description: "Demo JSON",
    pattern: ["https://demo.test/api/*"],
    collects: "json",
    colors: ["#123456", "white"],
    ...overrides
  },
  parse: () => { throw new Error("parses in the sandbox") },
  parseBody: async (body, context) => [
    new Story("DJ", body.items[0].url, body.items[0].title + " via " + context.url)
  ]
})

test("an add-on collector registers after the built-ins and leaves cleanly", () => {
  const before = get_active().length
  const remove = registerCollector(addonParser())
  const ids = get_active().map((parser) => parser.options.id)
  assert.equal(ids.length, before + 1)
  assert.equal(ids.at(-1), "addon:demo/json")
  assert.equal(get_parser_by_id("addon:demo/json")?.options.type, "DJ")
  assert.equal(get_parser_for_url("https://demo.test/api/items.json")?.options.id, "addon:demo/json")
  // Built-ins win detection: the add-on's pattern never captures their sources.
  assert.equal(get_parser_for_url("https://news.ycombinator.com/")?.options.id, "hackernews")
  remove()
  assert.equal(get_active().length, before)
  assert.equal(get_parser_by_id("addon:demo/json"), undefined)
})

test("ids must be namespaced and badges must not be a built-in's", () => {
  assert.throws(() => registerCollector(addonParser({ id: "json" })), /addon: ids/)
  assert.throws(() => registerCollector(addonParser({ type: "HN" })), /belongs to the built-in/)
})

test("parse_response hands a parseBody collector the decoded body and caches it", async () => {
  const remove = registerCollector(addonParser())
  try {
    const resolved = resolveStorySource({ url: "https://demo.test/api/items.json" })
    assert.equal(resolved.collector.options.id, "addon:demo/json")
    const cached = []
    const response = new Response(JSON.stringify({ items: [{ url: "https://demo.test/a", title: "A" }] }), {
      headers: { "content-type": "application/json" }
    })
    const stories = await parse_response(response, resolved, {
      cacheResult: async (url, content) => { cached.push([url, content[1]]) }
    })
    assert.equal(stories.length, 1)
    assert.equal(stories[0].title, "A via https://demo.test/api/items.json")
    assert.deepEqual(cached, [["https://demo.test/api/items.json", { items: [{ url: "https://demo.test/a", title: "A" }] }]])
  } finally {
    remove()
  }
})
