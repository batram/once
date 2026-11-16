const test = require("node:test")
const assert = require("node:assert/strict")
const { isWebUrl, keepWebLinks, webLink } = require("../../../packages/core/dist")

const SOURCE = "https://feed.test/news/index.xml"
// What a hostile feed item would name: Once's own pages, script, local files,
// and the relative form the extension tabs API resolves against the extension.
const HOSTILE = [
  "chrome-extension://abcdefghijklmnopabcdefghijklmnop/static/addon-conversation.html?run=addon:wwww/explain&href=https://victim.test/",
  "moz-extension://2c127fa4-62c7-4e3d-9d3b-000000000000/static/reader.html?pdf=1&sourceUrl=http://intranet.test/",
  "once-extension://id/page.html",
  "once-reader://read/?sourceUrl=https://a.test/",
  "once-history://page/",
  "javascript:alert(1)",
  " JavaScript:alert(1)",
  "data:text/html,<script>1</script>",
  "file:///C:/Users/x/secret.txt",
  "about:blank",
  "search:*group",
  "view-source:https://a.test/"
]

test("only absolute http(s) addresses are web addresses", () => {
  for (const url of ["https://a.test/", "http://a.test/x?y=1#z", "HTTPS://A.test/"]) assert.equal(isWebUrl(url), true, url)
  for (const url of [...HOSTILE, "/static/addon-conversation.html?run=x", "static/sidepanel.html", "//a.test/x", "a.test", "", "https://", null, undefined, 7, {}]) {
    assert.equal(isWebUrl(url), false, String(url))
  }
})

test("a relative link resolves against its source, and can never leave the web", () => {
  assert.equal(webLink("https://a.test/1", SOURCE), "https://a.test/1")
  assert.equal(webLink("/static/addon-conversation.html?run=x", SOURCE), "https://feed.test/static/addon-conversation.html?run=x")
  assert.equal(webLink("post/2", SOURCE), "https://feed.test/news/post/2")
  assert.equal(webLink("//other.test/3", SOURCE), "https://other.test/3")
  for (const url of [...HOSTILE, "", "   ", null, undefined]) assert.equal(webLink(url, SOURCE), null, String(url))
  // No usable source to resolve against: the link is dropped, not guessed.
  assert.equal(webLink("post/2", "not a url"), null)
})

test("ingestion drops stories that link off the web and strips such comment and tag links", () => {
  const stories = [
    ...HOSTILE.map((href, index) => ({ href, title: "hostile " + index, comment_url: "https://a.test/c", tags: [] })),
    {
      href: "https://a.test/kept",
      title: "kept",
      comment_url: HOSTILE[0],
      tags: [
        { class: "user", text: "feed", href: HOSTILE[1] },
        { class: "user", text: "web", href: "https://a.test/u" },
        { class: "category", text: "plain" },
        { class: "user", text: "relative", href: "/t/tag" }
      ],
      substories: [{ type: "X", comment_url: "javascript:alert(1)", timestamp: 0, tags: [{ class: "c", text: "t", href: "file:///etc/passwd" }] }]
    },
    { href: "post/2", title: "relative", comment_url: "post/2" },
    { href: "https://a.test/no-comments", title: "no comments" },
    null
  ]
  const kept = keepWebLinks(stories, SOURCE)
  assert.deepEqual(kept.map(story => story.href), ["https://a.test/kept", "https://feed.test/news/post/2", "https://a.test/no-comments"])
  assert.equal(kept[0].comment_url, "")
  assert.deepEqual(kept[0].tags, [
    { class: "user", text: "feed" },
    { class: "user", text: "web", href: "https://a.test/u" },
    { class: "category", text: "plain" },
    { class: "user", text: "relative", href: "https://feed.test/t/tag" }
  ])
  assert.deepEqual(kept[0].substories, [{ type: "X", comment_url: "", timestamp: 0, tags: [{ class: "c", text: "t" }] }])
  assert.equal(kept[1].comment_url, "https://feed.test/news/post/2")
  assert.equal("comment_url" in kept[2], false)
})
