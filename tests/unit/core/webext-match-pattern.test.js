const test = require("node:test")
const assert = require("node:assert/strict")
const {
  ALL_URLS,
  MatchPatternError,
  MatchPatternSet,
  isMatchPattern,
  matchPatternMatches,
  parseMatchPattern
} = require("../../../packages/core/dist/webext/matchPattern")

function matches(pattern, url) {
  return matchPatternMatches(parseMatchPattern(pattern), new URL(url))
}

test("<all_urls> matches every supported scheme and nothing else", () => {
  assert.equal(matches(ALL_URLS, "https://example.org/x?y#z"), true)
  assert.equal(matches(ALL_URLS, "file:///etc/hosts"), true)
  assert.equal(matches(ALL_URLS, "data:text/plain,hi"), true)
  assert.equal(matches(ALL_URLS, "moz-extension://abc/page.html"), false)
})

test("a * scheme is http or https only", () => {
  assert.equal(matches("*://example.org/*", "http://example.org/"), true)
  assert.equal(matches("*://example.org/*", "https://example.org/"), true)
  assert.equal(matches("*://example.org/*", "ws://example.org/"), false)
})

test("*.domain covers the bare domain and every subdomain", () => {
  assert.equal(matches("*://*.mozilla.org/*", "https://mozilla.org/"), true)
  assert.equal(matches("*://*.mozilla.org/*", "https://a.b.mozilla.org/"), true)
  assert.equal(matches("*://*.mozilla.org/*", "https://notmozilla.org/"), false)
  assert.equal(matches("*://mozilla.org/*", "https://www.mozilla.org/"), false)
})

test("the path glob is tested against path and query, never the fragment or port", () => {
  assert.equal(matches("https://example.org/a", "https://example.org/a"), true)
  assert.equal(matches("https://example.org/a", "https://example.org/a/"), false)
  assert.equal(matches("https://example.org/a*", "https://example.org/a?q=1"), true)
  assert.equal(matches("https://example.org/a", "https://example.org/a#frag"), true)
  assert.equal(matches("https://example.org/*", "https://example.org:8443/x"), true)
  assert.equal(matches("*://example.org/*/end", "https://example.org/x.y(z)/end"), true)
})

test("hosts are compared case-insensitively", () => {
  assert.equal(matches("https://Example.ORG/*", "https://example.org/"), true)
})

test("file patterns carry no host, spelled either way Firefox allows", () => {
  assert.equal(matches("file:///home/*", "file:///home/me/x.html"), true)
  assert.equal(matches("file://*/*", "file:///home/me/x.html"), true)
  assert.throws(() => parseMatchPattern("file://host/x"), MatchPatternError)
})

test("malformed patterns are rejected", () => {
  for (const bad of [
    "example.org/*",
    "https://example.org",
    "https:///*",
    "https://*example.org/*",
    "https://example.org:80/*",
    "gopher://example.org/*"
  ]) {
    assert.equal(isMatchPattern(bad), false, bad)
    assert.throws(() => parseMatchPattern(bad), MatchPatternError, bad)
  }
})

test("restrictSchemes off admits any scheme, the way Firefox does for webRequest filters", () => {
  const loose = { restrictSchemes: false }
  const pattern = parseMatchPattern("moz-extension://abc/*.user.js", loose)
  assert.equal(matchPatternMatches(pattern, new URL("moz-extension://abc/x.user.js")), true)
  assert.equal(matchPatternMatches(pattern, new URL("https://abc/x.user.js")), false)
  assert.equal(matchPatternMatches(parseMatchPattern("*://*/*.user.js", loose), new URL("moz-extension://abc/x.user.js")), false)
  assert.throws(() => parseMatchPattern("not a scheme://abc/*", loose), MatchPatternError)
  const set = new MatchPatternSet(["*://*/*.user.js", "moz-extension://abc/*.user.js"], loose)
  assert.equal(set.matches("http://127.0.0.1:1/once.user.js"), true)
  assert.equal(set.matches("moz-extension://abc/once.user.js"), true)
})

test("a pattern set answers for any of its members and tolerates bad URLs", () => {
  const set = new MatchPatternSet(["*://a.test/*", "https://b.test/x*"])
  assert.equal(set.size, 2)
  assert.equal(set.matches("http://a.test/anything"), true)
  assert.equal(set.matches(new URL("https://b.test/xyz")), true)
  assert.equal(set.matches("https://b.test/y"), false)
  assert.equal(set.matches("not a url"), false)
})
