const test = require("node:test")
const assert = require("node:assert/strict")

const {
  isResolved,
  resolveStorySource
} = require("../../../packages/collectors/dist/resolveSource")

const CONFIG = {
  stories: { sel: "article", all: true },
  link: { sel: "a", component: "href" },
  title: { sel: "h2", component: "innerText" }
}

test("a plain url resolves by pattern, with no configuration", () => {
  const source = {
    id: "src_11111111",
    url: "https://news.ycombinator.com/",
    label: "HN"
  }
  const resolved = resolveStorySource(source)
  assert.ok(isResolved(resolved))
  assert.equal(resolved.source, source, "resolution preserves source identity and metadata")
  assert.equal(resolved.collector.options.id, "hackernews")
  assert.equal(resolved.url, "https://news.ycombinator.com/")
  assert.equal(resolved.config, undefined)
})

test("a named collector wins over pattern detection", () => {
  // Which is the point of the field: a self-hosted instance on an unexpected
  // host, or one of the two collectors no pattern can reach.
  const resolved = resolveStorySource({
    url: "https://news.ycombinator.com/",
    collector: "rss"
  })
  assert.ok(isResolved(resolved))
  assert.equal(resolved.collector.options.id, "rss")
})

test("configuration is validated once, here, before anything is fetched", () => {
  const resolved = resolveStorySource({
    url: "https://a.test/",
    collector: "geny",
    select: CONFIG
  })
  assert.ok(isResolved(resolved))
  assert.deepEqual(resolved.config, CONFIG)

  const refused = resolveStorySource({
    url: "https://a.test/",
    collector: "geny",
    select: { nope: {} }
  })
  assert.equal(isResolved(refused), false)
  assert.match(refused.problem, /not a known field/)
})

test("an unknown collector id and an unmatched url both say why", () => {
  const named = resolveStorySource({ url: "https://a.test/", collector: "nope" })
  assert.equal(isResolved(named), false)
  assert.match(named.problem, /no collector with id "nope"/)

  const unmatched = resolveStorySource({ url: "https://a.test/" })
  assert.equal(isResolved(unmatched), false)
  assert.match(unmatched.problem, /no handler available/)
})
