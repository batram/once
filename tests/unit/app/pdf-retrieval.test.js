const test = require("node:test")
const assert = require("node:assert/strict")
const { retrieveDocument, fetchDocument } = require("../../../packages/app/dist/fetchDocument")
const fetchPdf = async () => new Response(new Uint8Array([37,80,68,70]), { headers: { "content-type": "application/pdf" } })

test("PDF retrieval preserves ordered pages, paragraphs and embedded/OCR provenance", async () => {
  const recognition = { recognizeImage() { assert.fail("the PDF adapter owns OCR decisions") } }
  const pdf = { async extract(bytes, port) {
    assert.deepEqual(bytes, new Uint8Array([37,80,68,70]))
    assert.equal(port, recognition)
    return { title: "Document title", pages: [
      { lines: ["An embedded sentence wraps", "over two lines."], method: "embedded" },
      { lines: [], method: "embedded" },
      { lines: ["Scanned sentence wraps", "over two lines too."], method: "ocr" }
    ] }
  } }
  const result = await retrieveDocument(fetchPdf, "https://example.test/document", recognition, pdf)
  assert.equal(result.kind, "text")
  assert.equal(result.method, "mixed")
  assert.equal(result.mediaType, "application/pdf")
  assert.equal(result.title, "Document title")
  assert.deepEqual(result.paragraphs, ["An embedded sentence wraps over two lines.", "Scanned sentence wraps over two lines too."])
  assert.equal(result.text, result.paragraphs.join("\n\n"))
  assert.equal(result.url, "https://example.test/document")
})

test("PDF adaptation escapes text and metadata for Reader and addons", async () => {
  const pdf = { async extract() { return { title: "<script>Title</script>", pages: [{ lines: ["<b>Untrusted PDF text</b>"], method: "embedded" }] } } }
  const result = await fetchDocument(fetchPdf,"https://example.test/a.pdf",undefined,pdf)
  assert.equal(result.mediaType,"text/plain")
  assert.match(result.html,/&lt;script&gt;Title/)
  assert.match(result.html,/&lt;b&gt;Untrusted/)
  assert.doesNotMatch(result.html,/<script>|<b>/)
})

test("PDF retrieval reports unsupported, empty and backend failures without returning incomplete text", async () => {
  await assert.rejects(retrieveDocument(fetchPdf,"https://example.test/a"), /PDF text extraction is not available/)
  await assert.rejects(retrieveDocument(fetchPdf,"https://example.test/a",undefined,{async extract(){return {pages:[{lines:[],method:"ocr"}]}}}), /No readable text/)
  await assert.rejects(retrieveDocument(fetchPdf,"https://example.test/a",undefined,{async extract(){throw new Error("PDF page 2 has no embedded text. OCR is not available")}}), /PDF page 2/)
})

test("PDF size limits reject headers and oversized streams before decoding", async () => {
  const pdf = {async extract(){ assert.fail("oversized PDF reached decoder") }}
  const limit = 64 * 1024 * 1024
  await assert.rejects(retrieveDocument(async()=>new Response(new Uint8Array([1]),{headers:{"content-type":"application/pdf","content-length":String(limit+1)}}),"https://example.test/a",undefined,pdf), /PDF too large/)
  let cancelled = false
  const fetch = async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(limit+1))},cancel(){cancelled=true}}),{headers:{"content-type":"application/pdf"}})
  await assert.rejects(retrieveDocument(fetch,"https://example.test/a",undefined,pdf), /PDF too large/)
  assert.equal(cancelled,true)
})

test("PDF page boundaries are never joined into a single paragraph", async () => {
  const pdf = { async extract() { return { pages: [
    { lines: ["An unfinished sentence"], method: "embedded" },
    { lines: ["starts lowercase on the next page."], method: "embedded" }
  ] } } }
  const result = await retrieveDocument(fetchPdf,"https://example.test/document",undefined,pdf)
  assert.equal(result.method,"embedded")
  assert.deepEqual(result.paragraphs,["An unfinished sentence","starts lowercase on the next page."])
})
