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
  const textRecognition = { async recognizeImage() { return { lines: [] } } }
  const client = readerAiMethods({
    textRecognition,
    fetch: async (_url, init) => { assert.equal(init.signal, signal); return new Response(new TextEncoder().encode("%PDF-1.7"), { headers: { "content-type": "application/pdf" } }) },
    pdfText: { async extract(_bytes, local, options) {
      assert.equal(local, textRecognition, "pages past the pictures use on-device OCR")
      assert.equal(options.pageImages, 47)
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
  assert.match(content[2].text, /pages 1 to 1 of 2 follow in order; later pages are only in the text/)
  assert.deepEqual(content.slice(3).map(part => [part.type, part.mediaType]), [["image", "image/jpeg"]], "an unknown picture format is skipped")
  assert.ok(progress.some(text => /page 1 of 2/.test(text)))
  assert.ok(progress.some(text => /Writing/.test(text)))
})

test("a long scan is rewritten one page range at a time and read further on the device", async () => {
  const calls = [], windows = []
  const pdf = new TextEncoder().encode("%PDF-1.7")
  const textRecognition = { async recognizeImage() { return { lines: ["x"] } } }
  const client = readerAiMethods({
    textRecognition,
    fetch: async () => new Response(pdf, { headers: { "content-type": "application/pdf" } }),
    pdfText: { async extract(_bytes, local, options) {
      windows.push({ pages: options.pages, pageImages: options.pageImages, local })
      for (let page = options.pages.from; page <= options.pages.to; page++) options.onPageImage?.(page, jpeg)
      return { pages: [{ lines: [`Page ${options.pages.from}`], method: "ocr" }], total: 29, through: options.pages.to }
    } }
  }, answer(calls, "<p>Pages six to ten</p>"))
  const result = await client.rewriteReaderAi({ sourceUrl: "https://example.test/scan.pdf", title: "scan.pdf", pages: { from: 6, to: 10 }, previous: "ended mid-sen" })
  assert.deepEqual(result.pages, { through: 10, total: 29 })
  assert.deepEqual(windows[0], { pages: { from: 6, to: 10 }, pageImages: 5, local: textRecognition })
  const request = calls[0].request
  assert.match(request.instructions, /only PDF pages 6 to 10 of 29/)
  assert.match(request.instructions, /do not begin with an h1/)
  assert.match(request.instructions, /ended mid-sen/)
  assert.equal(request.messages[0].content.filter(part => part.type === "image").length, 5)
  assert.match(request.messages[0].content[1].text, /pages 6 to 10 of 29/)

  const read = await client.readReaderPages("https://example.test/scan.pdf", { from: 11, to: 15 })
  assert.deepEqual(read, { paragraphs: ["Page 11"], pages: { through: 15, total: 29 } })
  assert.deepEqual(windows[1].pages, { from: 11, to: 15 })
  assert.equal(windows[1].local, textRecognition, "the device reads the next pages with its own OCR")
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
