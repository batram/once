const test = require("node:test")
const assert = require("node:assert/strict")
const { readerAiMethods } = require("../../../packages/app/dist/ai/readerAi")
const model = { connection: "test", provider: "compatible", name: "Test", model: "vision", revision: "a".repeat(64) }

test("explicit PDF OCR preserves embedded text, AI paragraphs, page order and provenance", async () => {
  const calls = [], progress = []
  const signal = new AbortController().signal
  const client = readerAiMethods({
    fetch: async () => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } }),
    pdfText: { async extract(_bytes, local, options) {
      assert.equal(local, undefined, "cloud recognition does not occupy the device-local OCR port")
      assert.equal(options.signal, signal)
      options.onPage(2, 2)
      const recognized = await options.cloud.recognizeImage(new Uint8Array([0x89, 0x50, 0, 0]), 2)
      return { pages: [{ lines: ["Embedded text."], method: "embedded" }, { ...recognized, method: "ocr" }] }
    } }
  }, async (consumer, request) => { calls.push({ consumer, request }); return { text: "first paragraph\n\nsecond paragraph", model, sources: [], fetched: false } })
  const result = await client.readDocumentAi("https://example.test/document.pdf", signal, text => progress.push(text), model)
  assert.deepEqual(result.paragraphs, ["Embedded text.", "first paragraph", "second paragraph"])
  assert.equal(result.ai.operation, "ocr")
  assert.equal(result.ai.model, "vision")
  assert.equal(result.method, "ai-ocr")
  assert.match(progress[0], /page 2 of 2/)
  assert.match(progress[1], /page 2/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].request.expectedRevision, model.revision)
})

test("formatting accepts structure only and pins the displayed model", async () => {
  const blocks = [{ id: "b0", text: "Exact words", kind: "p" }]
  let request
  const client = readerAiMethods({}, async (_consumer, value) => { request = value; return { text: '[{"id":"b0","kind":"h2"}]', model } })
  assert.deepEqual((await client.formatReaderAi(blocks, undefined, model)).blocks, [{ id: "b0", kind: "h2" }])
  assert.equal(request.expectedRevision, model.revision)
  const invalid = readerAiMethods({}, async () => ({ text: '[{"id":"b0","kind":"p","text":"Changed"}]', model }))
  await assert.rejects(invalid.formatReaderAi(blocks), /original retained/)
})
