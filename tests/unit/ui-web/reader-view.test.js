const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { installRawAssetLoader } = require("../../helpers/raw-assets")

function loadReaderView() {
  installRawAssetLoader()
  const { window } = parseHTML("<html><body></body></html>")
  globalThis.window = window
  globalThis.document = window.document
  globalThis.DOMParser = window.DOMParser
  globalThis.Element = window.Element
  globalThis.HTMLElement = window.HTMLElement
  globalThis.customElements = window.customElements
  const { Story } = require("../../../packages/core/dist")
  const { ReaderView } = require("../../../packages/ui-web/dist/reader/ReaderView")
  return { ReaderView, Story }
}

const ARTICLE = "<p>The stored article, with a <a href=\"/more\">relative link</a>" +
  " and a <script>alert(1)</script> that must not survive.</p>"

test("a story with stored content opens in the reader without a request", async () => {
  const { ReaderView, Story } = loadReaderView()
  const story = Story.from_obj({
    type: "rss", href: "https://example.com/a", title: "Stored title", timestamp: 1,
    stored_content: { source: "page", saved_at: 1, byline: "Ada", site_name: "Example" },
    _attachments: { content: { content_type: "text/html", length: 10, stub: true } }
  })
  const opened = []
  ReaderView.mount({
    async findStoryByUrl(url) { return url === story.href ? story : null },
    async getStoryContent(href) {
      assert.equal(href, story.href)
      return { html: ARTICLE, meta: story.stored_content }
    },
    async fetchDocument() { throw new Error("a stored story must not be fetched") }
  }, async (html, sourceUrl, target) => { opened.push({ html, sourceUrl, target }) })

  await ReaderView.open(story.href, "middle")

  assert.equal(opened.length, 1)
  assert.equal(opened[0].sourceUrl, story.href)
  assert.equal(opened[0].target, "middle")
  assert.match(opened[0].html, /<title>Stored title<\/title>/)
  assert.match(opened[0].html, /class="byline">Ada</)
  assert.match(opened[0].html, /href="https:\/\/example.com\/more"/, "links resolve against the story")
  assert.doesNotMatch(opened[0].html, /alert\(1\)/, "stored html is sanitized on the way out")
})

test("a story without stored content is fetched and extracted as before", async () => {
  const { ReaderView, Story } = loadReaderView()
  const story = new Story("rss", "https://example.com/b", "Live")
  const fetched = []
  ReaderView.mount({
    async findStoryByUrl() { return story },
    async getStoryContent() { throw new Error("nothing stored to read") },
    async fetchDocument(url) {
      fetched.push(url)
      throw new Error("fetch reached (extraction needs a browser DOM)")
    }
  }, async () => {})

  await assert.rejects(ReaderView.open(story.href), /fetch reached/)
  assert.deepEqual(fetched, [story.href])
})
