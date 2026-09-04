const test = require("node:test")
const assert = require("node:assert/strict")
const { URLRedirect } = require("../../../packages/core/dist")

test("rewrites urls, remembers the original, and resets on rule changes", () => {
  URLRedirect.setRedirects([
    { match_url: "^https://www\\.reddit\\.com", replace_url: "https://old.reddit.com" }
  ])

  assert.equal(
    URLRedirect.redirect_url("https://www.reddit.com/a"),
    "https://old.reddit.com/a"
  )
  assert.equal(
    URLRedirect.original_url("https://old.reddit.com/a"),
    "https://www.reddit.com/a"
  )

  //urls without a matching rule map to themselves in both directions
  assert.equal(
    URLRedirect.redirect_url("https://example.com/"),
    "https://example.com/"
  )
  assert.equal(
    URLRedirect.original_url("https://example.com/"),
    "https://example.com/"
  )

  URLRedirect.setRedirects([])
  assert.equal(
    URLRedirect.redirect_url("https://www.reddit.com/a"),
    "https://www.reddit.com/a"
  )
  assert.equal(
    URLRedirect.original_url("https://old.reddit.com/a"),
    "https://old.reddit.com/a"
  )
})

test("skips invalid redirect rules and applies rules in sequence", (t) => {
  t.mock.method(console, "warn", () => {})

  URLRedirect.setRedirects([
    { match_url: "([", replace_url: "broken" },
    { match_url: "^http:", replace_url: "https:" },
    { match_url: "example\\.com", replace_url: "example.org" }
  ])

  assert.equal(
    URLRedirect.redirect_url("http://example.com/x"),
    "https://example.org/x"
  )
  assert.equal(
    URLRedirect.original_url("https://example.org/x"),
    "http://example.com/x"
  )

  URLRedirect.setRedirects([])
})
