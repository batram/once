const test = require("node:test")
const assert = require("node:assert/strict")
const {
  MIN_FEED_CONTENT_CHARS,
  Story,
  feedContentIsArticle,
  projectStoryView,
  readAddonStories,
  textOfHtml
} = require("../../../packages/core/dist")

const ARTICLE = `<p>${"An article sentence with enough words to matter. ".repeat(12)}</p>`

test("attached html rides along as pending content until a store writes it", () => {
  const story = new Story("rss", "https://example.com/a", "A story")
  assert.equal(story.has_content(), false)
  assert.equal(story.contentSource(), undefined)
  assert.equal(story.pendingContent(), undefined)

  story.attachContent(ARTICLE, { source: "feed", saved_at: 5 })
  assert.equal(story.has_content(), true)
  assert.equal(story.contentSource(), "feed")
  assert.equal(story.pendingContent(), ARTICLE)
  assert.deepEqual(story._attachments.content, { content_type: "text/html", raw_content: ARTICLE })

  // Cloning through the document form keeps the pending html and its meta.
  const clone = Story.from_obj(story.to_obj())
  assert.equal(clone.pendingContent(), ARTICLE)
  assert.deepEqual(clone.stored_content, { source: "feed", saved_at: 5 })
})

test("a stored stub counts as content only when it has a length", () => {
  const stored = Story.from_obj({
    type: "rss", href: "https://example.com/a", title: "A", timestamp: 1,
    stored_content: { source: "page", saved_at: 1 },
    _attachments: { content: { content_type: "text/html", digest: "md5-x", length: 120, stub: true } }
  })
  assert.equal(stored.has_content(), true)
  assert.equal(stored.contentSource(), "page")
  assert.equal(stored.pendingContent(), undefined)

  const empty = Story.from_obj({
    type: "rss", href: "https://example.com/b", title: "B", timestamp: 1,
    _attachments: { content: { content_type: "text/html", stub: true } }
  })
  assert.equal(empty.has_content(), false)
  assert.equal(empty.contentSource(), undefined)
})

test("feed text counts as an article by its visible characters, not its markup", () => {
  assert.equal(textOfHtml("<p>Hello &amp; <b>bye</b></p>"), "Hello bye")
  assert.equal(feedContentIsArticle(ARTICLE), true)
  assert.equal(feedContentIsArticle("<p>Short teaser.</p>"), false)
  const tagsOnly = "<div><span></span></div>".repeat(200)
  assert.ok(tagsOnly.length > MIN_FEED_CONTENT_CHARS)
  assert.equal(feedContentIsArticle(tagsOnly), false)
})

test("add-ons neither set nor see stored content", () => {
  const [vetted] = readAddonStories([{
    href: "https://example.com/a", title: "A",
    stored_content: { source: "page", saved_at: 1 },
    _attachments: { content: { raw_content: "<p>x</p>" } },
    note: "kept"
  }], "AD")
  assert.equal(vetted.stored_content, undefined)
  assert.equal(vetted._attachments, undefined)
  assert.equal(vetted.note, "kept")

  const view = projectStoryView({
    href: "https://example.com/a", title: "A", type: "AD",
    stored_content: { source: "page", saved_at: 1 }, note: "kept"
  })
  assert.deepEqual(view.fields, { note: "kept" })
})
