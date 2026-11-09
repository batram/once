const test = require("node:test")
const assert = require("node:assert/strict")
const vm = require("node:vm")
const { LIVE_PAGE_SCRIPT, readLivePage, sameDocumentUrl } = require("../../../packages/app/dist/livePage")

function evaluate(contentType, html = "<html><body><p>Shown</p></body></html>") {
  return vm.runInNewContext(LIVE_PAGE_SCRIPT, {
    document: { contentType, documentElement: { outerHTML: html } },
    location: { href: "https://example.test/article#part" }
  })
}

test("an open HTML page answers with its document and the address it is at", () => {
  assert.deepEqual({ ...evaluate("text/html") }, { html: "<html><body><p>Shown</p></body></html>", url: "https://example.test/article#part" })
})

test("an image, a PDF viewer and a text file are left to the reader's own download", () => {
  // The engine wraps an image in a document of its own; read as a page it is an article with no text.
  for (const type of ["image/png", "application/pdf", "text/plain", "application/json"]) assert.equal(evaluate(type), null, type)
  assert.equal(evaluate("application/xhtml+xml")?.url, "https://example.test/article#part", "XHTML is a page too")
})

test("a document too large to be an article is not handed over", () => {
  assert.equal(evaluate("text/html", "x".repeat(8 * 1024 * 1024 + 1)), null)
  assert.equal(readLivePage({ html: "x".repeat(8 * 1024 * 1024 + 1), url: "https://example.test/" }), null)
})

test("the answer is read as a value or as the JSON a mobile bridge carries", () => {
  const page = { html: "<html lang=\"en\"><body><p>Line\nbreak</p></body></html>", url: "https://example.test/article" }
  assert.deepEqual(readLivePage(page), page)
  assert.deepEqual(readLivePage(JSON.stringify(page)), page, "the markup comes back unescaped")
  // WebKit's serializer also escapes the slashes of closing tags.
  assert.deepEqual(readLivePage(JSON.stringify(page).replaceAll("/", "\\/")), page)
  for (const nothing of [null, undefined, "null", "", "not json", "\"<html></html>\"", {}, { html: "", url: "u" }, { html: "<p>", url: 1 }]) {
    assert.equal(readLivePage(nothing), null, JSON.stringify(nothing))
  }
})

test("a fragment does not make another document", () => {
  assert.ok(sameDocumentUrl("https://example.test/a#one", "https://example.test/a"))
  assert.ok(!sameDocumentUrl("https://example.test/a?page=2", "https://example.test/a"))
})
