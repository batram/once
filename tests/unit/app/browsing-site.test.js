const test = require("node:test")
const assert = require("node:assert/strict")
const { siteForUrl, hostBelongsToSite } = require("../../../packages/app/dist/browsingSite")

test("a page's site is its registrable domain", () => {
  assert.equal(siteForUrl("https://news.ycombinator.com/item?id=1"), "ycombinator.com")
  assert.equal(siteForUrl("https://www.example.com/"), "example.com")
  assert.equal(siteForUrl("http://login.example.co.uk/a"), "example.co.uk")
  assert.equal(siteForUrl("https://example.com"), "example.com")
})

test("hosts without a public suffix are their own site", () => {
  assert.equal(siteForUrl("http://localhost:3211/x"), "localhost")
  assert.equal(siteForUrl("http://127.0.0.1:8080/"), "127.0.0.1")
  assert.equal(siteForUrl("http://[::1]:8080/"), "::1")
})

test("pages that are not on the web have no site", () => {
  assert.equal(siteForUrl("about:blank"), null)
  assert.equal(siteForUrl("once-reader://https/example.com/"), null)
  assert.equal(siteForUrl("file:///C:/x.html"), null)
  assert.equal(siteForUrl("not a url"), null)
})

test("a host belongs to a site when it is the site or a subdomain of it", () => {
  assert.equal(hostBelongsToSite("example.com", "example.com"), true)
  assert.equal(hostBelongsToSite(".example.com", "example.com"), true)
  assert.equal(hostBelongsToSite("a.b.example.com", "example.com"), true)
  assert.equal(hostBelongsToSite("notexample.com", "example.com"), false)
  assert.equal(hostBelongsToSite("example.com.evil.test", "example.com"), false)
})
