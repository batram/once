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

const { retrieveDocument } = require("../../../packages/app/dist/fetchDocument")
const { MAX_IMAGE_BYTES } = require("../../../packages/app/dist/textRetrieval")

function imageResponse(body = new Uint8Array([1, 2, 3]), headers = {}) {
  return async () => new Response(body, { headers: { "content-type": "image/jpeg", ...headers } })
}

test("retrieval exposes OCR as plain text and preserves line order", async () => {
  const result = await retrieveDocument(imageResponse(), "https://example.test/image", {
    async recognizeImage(bytes) {
      assert.deepEqual(bytes, new Uint8Array([1, 2, 3]))
      return { lines: [" Title ", "", "First principle", "Second principle"] }
    }
  })
  assert.equal(result.kind, "text")
  assert.equal(result.method, "ocr")
  assert.equal(result.text, "Title\n\nFirst principle\n\nSecond principle")
  assert.deepEqual(result.lines, ["Title", "First principle", "Second principle"])
  assert.equal(result.mediaType, "image/jpeg")
})

test("reader adapter escapes recognized text and supports short images", async () => {
  const result = await fetchDocument(imageResponse(), "https://example.test/image.jpeg", {
    async recognizeImage() { return { lines: ['<script>"hi" & bye</script>'] } }
  })
  assert.equal(result.mediaType, "text/plain")
  assert.match(result.html, /&lt;script&gt;&quot;hi&quot; &amp; bye/)
  assert.doesNotMatch(result.html, /<script>/)
})

test("image retrieval explains missing OCR support and empty recognition", async () => {
  await assert.rejects(retrieveDocument(imageResponse(), "https://example.test/image"), /not available on this platform/)
  await assert.rejects(retrieveDocument(imageResponse(), "https://example.test/image", {
    async recognizeImage() { return { lines: [" ", ""] } }
  }), /No text was found/)
})

test("oversized image headers and streamed bytes never reach recognition", async () => {
  const recognition = { async recognizeImage() { assert.fail("oversized input reached OCR") } }
  await assert.rejects(retrieveDocument(imageResponse(undefined, { "content-length": String(MAX_IMAGE_BYTES + 1) }),
    "https://example.test/image", recognition), /Image too large/)
  let cancelled = false
  const fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES + 1)) },
    cancel() { cancelled = true }
  }), { headers: { "content-type": "image/png" } })
  await assert.rejects(retrieveDocument(fetch, "https://example.test/image", recognition), /Image too large/)
  assert.equal(cancelled, true)
})
