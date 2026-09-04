const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { parseDocument } = require("../../helpers/dom")
const { assertStories } = require("../../helpers/collector-contract")

const fixture = (name) => fs.readFileSync(path.resolve(__dirname, `../../fixtures/collectors/${name}`), "utf8")

test("parses RSS 2 and recovers a missing title from content", () => {
  const collector = require("../../../packages/collectors/dist/collectors/vanillaRss")
  const previous = collector.options.settings.time_cut_off.value
  collector.options.settings.time_cut_off.value = 10000
  try {
    const stories = collector.parse(parseDocument(fixture("rss.xml"), "text/xml"))
    assertStories(stories, "RSS", 2)
    assert.match(stories[1].title, /recovered from content/)
  } finally {
    collector.options.settings.time_cut_off.value = previous
  }
})

test("parses Atom and filters old or timeless entries according to settings", () => {
  const collector = require("../../../packages/collectors/dist/collectors/vanillaRss")
  const previous = collector.options.settings.time_cut_off.value
  collector.options.settings.time_cut_off.value = 10000
  try {
    const stories = collector.parse(parseDocument(fixture("atom.xml"), "text/xml"))
    assertStories(stories, "RSS")
    assert.equal(stories[0].title, "Atom story")
  } finally {
    collector.options.settings.time_cut_off.value = previous
  }
})

function withLongCutOff(collector, run) {
  const previous = collector.options.settings.time_cut_off.value
  collector.options.settings.time_cut_off.value = 10000
  try {
    return run()
  } finally {
    collector.options.settings.time_cut_off.value = previous
  }
}

test("attaches feed text that reads as an article and leaves teasers alone", () => {
  const collector = require("../../../packages/collectors/dist/collectors/vanillaRss")
  withLongCutOff(collector, () => {
    const stories = collector.parse(parseDocument(fixture("rss.xml"), "text/xml"))
    const [article, teaser] = stories
    assert.equal(article.has_content(), true)
    assert.equal(article.contentSource(), "feed")
    assert.match(article.pendingContent(), /^<p>The feed carries the whole article/)
    assert.match(article.pendingContent(), /href="\/relative\/link"/)
    assert.equal(typeof article.stored_content.saved_at, "number")
    // A one-line description is a title fallback, not an article.
    assert.equal(teaser.has_content(), false)
    assert.equal(teaser.stored_content, undefined)
  })
})

test("reads Atom content by its type and skips a bare summary", () => {
  const collector = require("../../../packages/collectors/dist/collectors/vanillaRss")
  withLongCutOff(collector, () => {
    const stories = collector.parse(parseDocument(fixture("atom.xml"), "text/xml"))
    assert.deepEqual(stories.map((story) => story.title), ["Atom story", "Atom xhtml story", "Atom teaser"])
    const [html, xhtml, teaser] = stories
    assert.match(html.pendingContent(), /^<p>Atom content arrives as escaped markup/)
    assert.match(xhtml.pendingContent(), /<p>Inline XHTML content is real markup/)
    assert.doesNotMatch(xhtml.pendingContent(), /^<div/, "the wrapping div is not part of the article")
    assert.equal(teaser.has_content(), false)
  })
})

test("the store_content setting turns feed text off", () => {
  const collector = require("../../../packages/collectors/dist/collectors/vanillaRss")
  const previous = collector.options.settings.store_content.value
  collector.options.settings.store_content.value = false
  try {
    withLongCutOff(collector, () => {
      const stories = collector.parse(parseDocument(fixture("rss.xml"), "text/xml"))
      assert.equal(stories[0].has_content(), false)
      assert.equal(stories[0].title, "RSS story")
    })
  } finally {
    collector.options.settings.store_content.value = previous
  }
})

test("parses Reddit Atom entries", () => {
  const collector = require("../../../packages/collectors/dist/collectors/redditRss")
  const stories = collector.parse(parseDocument(fixture("reddit-atom.xml"), "text/xml"))
  assertStories(stories, "re")
  assert.equal(stories[0].title, "Reddit RSS story")
})
