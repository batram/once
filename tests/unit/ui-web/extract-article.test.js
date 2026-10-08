const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

function loadExtractor() {
  const { window } = parseHTML("<html><body></body></html>")
  globalThis.window = window
  globalThis.document = window.document
  globalThis.DOMParser = window.DOMParser
  globalThis.Element = window.Element
  globalThis.HTMLElement = window.HTMLElement
  return require("../../../packages/ui-web/dist/reader/extractArticle")
}

const paragraphs = Array.from({ length: 6 }, (_, index) =>
  `<p>Paragraph ${index + 1} of the article explains the network stack in enough words for the reader to count it as real content, not navigation.</p>`).join("")

// React's streaming server rendering: the boundary's place holds a template,
// the content waits hidden at the end of the body for a script to swap in.
const streamed = `<!doctype html><html><head><title>Streamed</title></head><body>
<nav><a href="/">Home</a><a href="/blog">Blog</a></nav>
<main><article><h1>The network stack</h1><!--$?--><template id="B:0"></template><!--/$--></article></main>
<div hidden id="S:0">${paragraphs}</div>
<script>$RC=function(a,b){}</script>
</body></html>`

test("an article that React streams behind a hidden Suspense container is extracted as the browser would show it", () => {
  const { extractArticle, revealStreamedContent } = loadExtractor()
  const { Readability } = require("@mozilla/readability")
  // Readability alone sees an empty placeholder and an invisible article.
  const bare = new DOMParser().parseFromString(streamed, "text/html")
  assert.doesNotMatch(new Readability(bare, { charThreshold: 140 }).parse()?.content ?? "", /Paragraph 1 of the article/)
  // With the swap done first it reads the article the browser would show.
  const revealed = new DOMParser().parseFromString(streamed, "text/html")
  revealStreamedContent(revealed)
  const parsed = new Readability(revealed, { charThreshold: 140 }).parse()
  assert.match(parsed.content, /Paragraph 1 of the article/)
  assert.match(parsed.content, /Paragraph 6 of the article/)
  assert.equal(/id="S:0"|hidden/.test(parsed.content), false, "the container itself does not survive")
  // The extractor used by the reader and by add-ons therefore no longer refuses the page.
  // (linkedom's DOMParser drops a bare fragment's body, so the sanitized markup is checked in the browser, not here.)
  assert.equal(extractArticle(streamed, "https://example.test/blog/post/").title, "Streamed")
})

test("the swap only moves a container into its own placeholder and leaves other markup alone", () => {
  const { revealStreamedContent } = loadExtractor()
  const doc = new DOMParser().parseFromString(
    '<!doctype html><html><head></head><body><div><template id="B:1"></template></div><div hidden id="S:1"><p>one</p></div><template id="B:2"></template><div hidden id="other">keep</div></body></html>', "text/html")
  revealStreamedContent(doc)
  assert.equal(doc.body.innerHTML.replace(/hidden=""/g, "hidden"), '<div><p>one</p></div><template id="B:2"></template><div hidden id="other">keep</div>')
})
