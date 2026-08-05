const test = require("node:test")
const assert = require("node:assert/strict")
const { fetchDocument } = require("../../../packages/app/dist/fetchDocument")

function respond(contentType, body = "<!doctype html><p>Body</p>") {
  return async (url) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    url,
    headers: { get: () => contentType },
    text: async () => body
  })
}

test("reads an HTML document and reports its media type", async () => {
  const document = await fetchDocument(
    respond("text/html; charset=utf-8"),
    "https://example.test/article"
  )

  assert.equal(document.mediaType, "text/html")
  assert.equal(document.url, "https://example.test/article")
  assert.match(document.html, /Body/)
})

// Sites that serve XHTML are ordinary articles; only the declared type differs.
test("reads an XHTML document", async () => {
  const document = await fetchDocument(
    respond("application/xhtml+xml"),
    "https://example.test/article.xhtml"
  )

  assert.equal(document.mediaType, "application/xhtml+xml")
})

test("rejects a document the reader cannot extract", async () => {
  await assert.rejects(
    fetchDocument(respond("application/pdf"), "https://example.test/paper.pdf"),
    /Reader mode cannot display application\/pdf/
  )
})

test("rejects a response without a content type", async () => {
  await assert.rejects(
    fetchDocument(respond(null), "https://example.test/unknown"),
    /Reader mode cannot display this content type/
  )
})

test("rejects a non-HTTP source", async () => {
  await assert.rejects(
    fetchDocument(respond("text/html"), "file:///etc/passwd"),
    /only supports HTTP and HTTPS/
  )
})
