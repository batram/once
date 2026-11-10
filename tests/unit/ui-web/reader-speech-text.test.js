const assert = require("node:assert/strict")
const test = require("node:test")
const { parseHTML } = require("linkedom")

const textPolicy = { exports: require("../../../packages/ui-web/dist/reader/readerSpeechText") }

test("reader speech normalization removes visual punctuation and simplifies URLs", () => {
  assert.equal(
    textPolicy.exports.normalizeReaderSpeechText(
      "Read\u200B https://www.example.com/story?q=1… A & B — #today!!!"
    ),
    "Read example.com A and B , today!"
  )
})

test("reader speech chunking observes the maximum at sentence and word boundaries", () => {
  assert.deepEqual(
    textPolicy.exports.splitReaderSpeechText("First sentence. Second sentence.", 20),
    ["First sentence.", "Second sentence."]
  )
  assert.deepEqual(
    textPolicy.exports.splitReaderSpeechText("alpha beta gamma", 10),
    ["alpha beta", "gamma"]
  )
})

test("reader speech segmentation uses leaf blocks and preserves their DOM owner", () => {
  const { document } = parseHTML("<article><div><p>First.</p><p>Second.</p></div></article>")
  const paragraphs = document.querySelectorAll("p")
  paragraphs.forEach((paragraph) => { paragraph.innerText = paragraph.textContent })
  const segments = textPolicy.exports.createReaderSpeechSegments(
    document.querySelector("article")
  )
  assert.deepEqual(segments.map(({ text }) => text), ["First.", "Second."])
  assert.equal(segments[0].element, paragraphs[0])
  assert.equal(segments[1].element, paragraphs[1])
})

test("reader speech wraps loose text between blocks into its own paragraph", () => {
  // paulgraham.com leaves paragraphs as bare text nodes between <p> tags.
  const { document } = parseHTML(
    "<article>" +
    "<span>[<a href=\"#f2n\">2</a>]</span>" +
    "<p>Network effects make companies more powerful.</p>" +
    "<span>[<a href=\"#f3n\">3</a>]</span>\nIt's surprising how often it\ncan be done." +
    "<p>Often you can induce network effects.</p>" +
    "</article>"
  )
  const article = document.querySelector("article")
  const segments = textPolicy.exports.createReaderSpeechSegments(article)
  assert.deepEqual(segments.map(({ text }) => text), [
    "Network effects make companies more powerful.",
    "It's surprising how often it can be done.",
    "Often you can induce network effects."
  ])
  const paragraphs = Array.from(article.querySelectorAll("p"))
  assert.equal(paragraphs.length, 4, "leading [2] and loose [3] runs each get a paragraph")
  assert.equal(segments[1].element, paragraphs[2])
  assert.equal(segments[1].element.tagName, "P")
})

test("reader speech leaves fully wrapped content untouched", () => {
  const { document } = parseHTML("<article><div><p>One.</p><p>Two.</p></div></article>")
  const article = document.querySelector("article")
  const before = article.innerHTML
  textPolicy.exports.createReaderSpeechSegments(article)
  assert.equal(article.innerHTML, before)
})

test("reader speech normalization drops footnote markers and path-only links", () => {
  assert.equal(
    textPolicy.exports.normalizeReaderSpeechText("Ideas [3] matter [citation needed]."),
    "Ideas matter ."
  )
  assert.equal(
    textPolicy.exports.normalizeReaderSpeechText("See www.example.com/a/very/long/path?x=1 and `code`"),
    "See example.com and code"
  )
})

test("reader speech skips bracket-only fragments and broken note markers", () => {
  // paulgraham.com notes render as <p>[</p> followed by loose "1] text".
  const { document } = parseHTML(
    "<article><span><p>Notes</p><p>[</p>1] You can also make tokens flow.<p>[</p>2] Second.</span></article>"
  )
  const segments = textPolicy.exports.createReaderSpeechSegments(
    document.querySelector("article")
  )
  assert.deepEqual(segments.map(({ text }) => text), [
    "Notes", "You can also make tokens flow.", "Second."
  ])
})

test("reader speech announces long code blocks instead of reading them", () => {
  const { document } = parseHTML(
    "<article><p>Intro.</p><pre>let a = 1</pre>" +
    "<pre>line 1\nline 2\nline 3\nline 4\nline 5</pre></article>"
  )
  const segments = textPolicy.exports.createReaderSpeechSegments(
    document.querySelector("article")
  )
  assert.deepEqual(segments.map(({ text }) => text), [
    "Intro.", "let a 1", "Code block, 5 lines."
  ])
})

test("OCR line wraps produce one speech segment per reconstructed paragraph", () => {
  const { recognizedDocument, documentHtml } = require("../../../packages/app/dist/textRetrieval")
  const result = recognizedDocument({
    lines: ["Subject: Communication", "There are two schools of thought. By far the", "most common way is chain of command.", "Instead, talk directly to one another."],
    lineBounds: [
      { x: 10, y: 10, width: 180, height: 16 },
      { x: 46, y: 50, width: 450, height: 16 },
      { x: 10, y: 76, width: 500, height: 16 },
      { x: 10, y: 116, width: 400, height: 16 }
    ]
  }, "https://example.test/memo.png", "image/png")
  const { document } = parseHTML(documentHtml(result))
  const segments = textPolicy.exports.createReaderSpeechSegments(document.querySelector("article"))
  assert.deepEqual(segments.map(({ text }) => text), [
    "Subject: Communication",
    "There are two schools of thought. By far the most common way is chain of command.",
    "Instead, talk directly to one another."
  ])
})
