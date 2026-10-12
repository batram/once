const test = require("node:test")
const assert = require("node:assert/strict")
const { readerAiMethods } = require("../../../packages/app/dist/ai/readerAi")
const model = { connection: "test", provider: "compatible", name: "Test", model: "vision", revision: "a".repeat(64) }
const jpeg = new Uint8Array([0xff, 0xd8, 1, 2])
const answer = (calls, text = "<h1>Title</h1><p>Body</p>") => async (consumer, request, _signal, onText) => { calls.push({ consumer, request }); onText?.(text); return { text, model, sources: [], fetched: false } }
const parts = call => call.request.messages[0].content

test("a PDF sends the extraction, its embedded text and pictures of its pages", async () => {
  const calls = [], progress = []
  const signal = new AbortController().signal
  const client = readerAiMethods({
    fetch: async (_url, init) => { assert.equal(init.signal, signal); return new Response(new TextEncoder().encode("%PDF-1.7"), { headers: { "content-type": "application/pdf" } }) },
    pdfText: { async extract(_bytes, local, options) {
      assert.equal(local, undefined)
      assert.equal(options.pageImages, 16)
      options.onPage(1, 2); options.onPageImage(1, jpeg); options.onPageImage(2, new Uint8Array([1, 2, 3]))
      return { pages: [{ lines: ["Embedded text."], method: "embedded" }, { lines: [], method: "embedded" }], title: "Meta" }
    } }
  }, answer(calls, "```html\n<h1>Title</h1><p>Body</p>\n```"))
  const result = await client.rewriteReaderAi({ sourceUrl: "https://example.test/document.pdf", html: "<p>Extracted</p>", title: "document.pdf" }, signal, text => progress.push(text))
  assert.equal(result.html, "<h1>Title</h1><p>Body</p>", "code fences are removed")
  assert.equal(result.model, model)
  assert.equal(calls[0].consumer, "reader.formatting")
  const content = parts(calls[0])
  assert.match(content[0].text, /document\.pdf/)
  assert.match(content[1].text, /<p>Extracted<\/p>/)
  assert.match(content[2].text, /Embedded text\./)
  assert.match(content[2].text, /Meta/)
  assert.deepEqual(content.slice(3).map(part => [part.type, part.mediaType]), [["image", "image/jpeg"]], "an unknown picture format is skipped")
  assert.ok(progress.some(text => /page 1 of 2/.test(text)))
  assert.ok(progress.some(text => /Writing/.test(text)))
})

test("an image source is sent as a picture, and a page as text without its markup", async () => {
  const calls = []
  const image = readerAiMethods({ fetch: async () => new Response(jpeg, { headers: { "content-type": "image/jpeg" } }) }, answer(calls))
  await image.rewriteReaderAi({ sourceUrl: "https://example.test/memo.jpeg", html: "" })
  assert.deepEqual(parts(calls[0]).map(part => part.type), ["text", "text", "image"])
  const page = readerAiMethods({ fetch: async () => new Response("<html><script>secret()</script><style>p{}</style><p>Visible <b>words</b></p></html>", { headers: { "content-type": "text/html" } }) }, answer(calls))
  await page.rewriteReaderAi({ sourceUrl: "https://example.test/", html: "<p>Visible words</p>" })
  const raw = parts(calls[1])[2].text
  assert.match(raw, /Visible words/)
  assert.doesNotMatch(raw, /secret|<b>|p\{\}/)
})

test("an unreadable source still sends the extraction, but nothing at all is refused", async () => {
  const calls = []
  const client = readerAiMethods({ fetch: async () => new Response("", { status: 503 }) }, answer(calls))
  await client.rewriteReaderAi({ sourceUrl: "https://example.test/", html: "<p>Extracted</p>" })
  assert.match(parts(calls[0]).at(-1).text, /could not be read \(HTTP 503\)/)
  await assert.rejects(client.rewriteReaderAi({ sourceUrl: "https://example.test/", html: " " }), /HTTP 503/)
  assert.equal(calls.length, 1)
})
