const test = require("node:test")
const assert = require("node:assert/strict")
const { URLRedirect } = require("../../../packages/core/dist")

test("rewrites urls, remembers the original, and resets on rule changes", () => {
  URLRedirect.setRedirects([
    { match_url: "^https://twitter\\.com", replace_url: "https://nitter.net" }
  ])

  assert.equal(
    URLRedirect.redirect_url("https://twitter.com/a"),
    "https://nitter.net/a"
  )
  assert.equal(
    URLRedirect.original_url("https://nitter.net/a"),
    "https://twitter.com/a"
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
    URLRedirect.redirect_url("https://twitter.com/a"),
    "https://twitter.com/a"
  )
  assert.equal(
    URLRedirect.original_url("https://nitter.net/a"),
    "https://nitter.net/a"
  )
})

test("skips invalid redirect rules and applies rules in sequence", () => {
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
