const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { readFormatBlocks, readFormatEdits } = require("../../../packages/core/dist")
const { captureFormatBlocks } = require("../../../packages/ui-web/dist/reader/readerFormatting")

test("formatting preserves source wording, links, images, tables, code and math", () => {
  const { document } = parseHTML('<html><body><article><p>Heading</p><p>A <a href="https://example.test">link</a> with <img src="image.png">.</p><table><tr><td><p>Table text</p></td></tr></table><pre><code>code()</code></pre><math><mi>x</mi></math></article></body></html>')
  global.document = document
  const article = document.querySelector("article")
  const link = article.querySelector("a"), image = article.querySelector("img"), table = article.querySelector("table"), math = article.querySelector("math")
  const source = captureFormatBlocks(article)
  assert.equal(source.blocks.length, 2)
  const edits = readFormatEdits('[{"id":"b0","kind":"h2"},{"id":"b1","kind":"p"}]', source.blocks)
  source.apply(edits)
  assert.equal(article.querySelector("h2").textContent, "Heading")
  assert.equal(article.querySelector("a"), link)
  assert.equal(article.querySelector("img"), image)
  assert.equal(article.querySelector("table"), table)
  assert.equal(article.querySelector("math"), math)
  assert.equal(article.querySelector("code").textContent, "code()")
  delete global.document
})

test("unknown, reordered, missing or rewritten source blocks are rejected", () => {
  const blocks = readFormatBlocks([{ id: "b0", kind: "p", text: "Original" }, { id: "b1", kind: "p", text: "Second" }])
  for (const value of [[], [{ id: "b1", kind: "p" }, { id: "b0", kind: "p" }], [{ id: "b0", kind: "script" }, { id: "b1", kind: "p" }], [{ id: "b0", kind: "p", text: "Rewrite" }, { id: "b1", kind: "p" }]]) assert.throws(() => readFormatEdits(JSON.stringify(value), blocks), /original retained/)
})

test("plain blocks permit paragraph and broken-word repairs but reject altered wording", () => {
  const source = [{ id: "b0", kind: "p", text: "A bro-\nken word.\nAnother paragraph.", repairable: true }]
  assert.deepEqual(readFormatEdits('[{"id":"b0","kind":"p","text":"A broken word.\\n\\nAnother paragraph."}]', source), [{ id: "b0", kind: "p", text: "A broken word.\n\nAnother paragraph." }])
  assert.throws(() => readFormatEdits('[{"id":"b0","kind":"p","text":"A better word."}]', source), /rewrote/)
  assert.throws(() => readFormatEdits('[{"id":"b0","kind":"p","text":"A broken word. Another paragraph."}]', [{ ...source[0], repairable: false }]), /rewrote/)
})

test("validated plain-text repairs split paragraphs without replacing neighboring media", () => {
  const { document } = parseHTML('<html><body><article><p>A bro-\nken word.\nAnother paragraph.</p><img src="retained.png"></article></body></html>')
  global.document = document
  const article = document.querySelector("article"), image = article.querySelector("img")
  const source = captureFormatBlocks(article)
  source.apply(readFormatEdits('[{"id":"b0","kind":"p","text":"A broken word.\\n\\nAnother paragraph."}]', source.blocks))
  assert.deepEqual([...article.querySelectorAll("p")].map(node => node.textContent), ["A broken word.", "Another paragraph."])
  assert.equal(article.querySelector("img"), image)
  delete global.document
})
