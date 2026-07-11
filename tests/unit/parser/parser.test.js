const test = require("node:test")
const assert = require("node:assert/strict")
const { installDomGlobals } = require("../../helpers/dom")
const {
  patternMatches,
  get_parser_for_url,
  parse_response,
  parse_xml
} = require("../../../packages/collectors/dist/parser")

installDomGlobals()

test("matches exact prefixes and one-wildcard collector patterns", () => {
  assert.equal(patternMatches("https://news.ycombinator.com/newest", ["https://news.ycombinator.com/"]), true)
  assert.equal(patternMatches("https://old.reddit.com/r/netsec/.json", ["https://old.reddit.com/*.json"]), true)
  assert.equal(patternMatches("https://example.com/feed.xml", ["*.rss"]), false)
  assert.throws(() => patternMatches("x", ["a*b*c"]), /only one wildcard/)
})

test("reports the selected parser and leaves unsupported URLs unmatched", () => {
  let matched
  const parser = get_parser_for_url("https://old.reddit.com/r/netsec/.json", {
    onParserMatched: (type) => { matched = type }
  })
  assert.equal(parser.options.type, "re")
  assert.equal(matched, "re")
  assert.equal(get_parser_for_url("https://unsupported.example/"), undefined)
})

test("parses and caches JSON responses while cache failures stay non-fatal", async () => {
  const fixture = require("../../fixtures/collectors/reddit.json")
  const cached = []
  const stories = await parse_response(
    new Response(JSON.stringify(fixture)),
    "https://old.reddit.com/r/netsec/.json",
    "https://old.reddit.com/r/netsec/.json",
    { cacheResult: async (url, content) => cached.push({ url, content }) }
  )
  assert.equal(stories.length, 1)
  assert.equal(cached.length, 1)

  const again = await parse_response(
    new Response(JSON.stringify(fixture)),
    "https://old.reddit.com/r/netsec/.json",
    "https://old.reddit.com/r/netsec/.json",
    { cacheResult: async () => { throw new Error("disk full") } }
  )
  assert.equal(again.length, 1)
})

test("adds an HTML base element and rejects unrecoverable XML", () => {
  const doc = require("../../../packages/collectors/dist/parser").parse_dom("<html><head></head><body></body></html>", "https://example.com/base/")
  assert.equal(doc.querySelector("base").href, "https://example.com/base/")
  const RealDOMParser = globalThis.DOMParser
  globalThis.DOMParser = class {
    parseFromString() {
      return {
        querySelector(selector) {
          return selector === "parsererror" ? { textContent: "mismatched tag" } : null
        }
      }
    }
  }
  try {
    assert.throws(() => parse_xml("<rss><item></rss>"), /XML parsing failed: mismatched tag/)
  } finally {
    globalThis.DOMParser = RealDOMParser
  }
})

test("wraps unsupported and malformed response failures with useful context", async () => {
  await assert.rejects(() => parse_response(new Response("{}"), "https://invalid/", "https://invalid/"), /no parser found/)
  await assert.rejects(() => parse_response(new Response("not json"), "https://old.reddit.com/r/x/.json", "https://old.reddit.com/r/x/.json"), /JSON parsing failed/)
})
