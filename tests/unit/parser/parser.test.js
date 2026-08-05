const test = require("node:test")
const assert = require("node:assert/strict")
const { installDomGlobals } = require("../../helpers/dom")
const {
  patternMatches,
  get_parser_for_url,
  parse_response,
  parse_xml
} = require("../../../packages/collectors/dist/parser")
const {
  resolveStorySource
} = require("../../../packages/collectors/dist/resolveSource")

installDomGlobals()

// parse_response no longer looks a collector up itself: resolution does that,
// and validates the configuration at the same time.
function resolve(url, source = {}) {
  const resolved = resolveStorySource({ url, ...source })
  if (resolved.problem) throw new Error(resolved.problem)
  return resolved
}

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

test("parses and caches JSON responses while cache failures stay non-fatal", async (t) => {
  t.mock.method(console, "log", () => {})

  const fixture = require("../../fixtures/collectors/reddit.json")
  const cached = []
  const stories = await parse_response(
    new Response(JSON.stringify(fixture)),
    resolve("https://old.reddit.com/r/netsec/.json"),
    { cacheResult: async (url, content) => cached.push({ url, content }) }
  )
  assert.equal(stories.length, 1)
  assert.equal(cached.length, 1)

  const again = await parse_response(
    new Response(JSON.stringify(fixture)),
    resolve("https://old.reddit.com/r/netsec/.json"),
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

test("wraps malformed response failures with useful context", async () => {
  await assert.rejects(
    () => parse_response(new Response("not json"), resolve("https://old.reddit.com/r/x/.json")),
    /JSON parsing failed/
  )
})

test("an unhandled source is refused at resolution, before any fetch", () => {
  // Previously this surfaced as "no parser found" from parse_response, i.e.
  // after the request had already been made.
  const resolved = resolveStorySource({ url: "https://unsupported.example/" })
  assert.match(resolved.problem, /no handler available/)
})
