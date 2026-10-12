const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

const model = { connection: "c", provider: "anthropic", name: "Fixture", model: "vision", revision: "a".repeat(64) }

/** A reader page for a 12-page scan whose first 5 pages were read on the device. */
function readerPage() {
  const { window } = parseHTML(`<html data-reader-pages="5/12"><head><title>scan.pdf</title></head><body>
    <header class="toolbar"><a class="reader-original" href="https://example.test/scan.pdf">Original</a></header>
    <main><h1>scan.pdf</h1><article><p>Garbled page one</p></article></main></body></html>`)
  globalThis.window = window
  globalThis.document = window.document
  globalThis.Event = window.Event
  const requests = []
  const answers = []
  const send = async request => { requests.push(request); return answers.shift()?.(request) }
  require("../../../packages/ui-web/dist/reader/readerAiControls").installReaderAi(send)
  const document = window.document
  const footer = () => document.querySelector(".reader-ai-status")
  const next = () => footer().querySelectorAll("button")[0]
  const end = () => footer().querySelectorAll("button")[1]
  const ai = () => [...document.querySelectorAll(".reader-ai button")].find(button => /^(AI|Cancel)$/.test(button.textContent))
  const undo = () => [...document.querySelectorAll(".reader-ai button")].find(button => button.textContent === "Undo")
  const paragraphs = () => [...document.querySelectorAll("article > *")].map(node => node.textContent)
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  return { document, requests, answers, footer, next, end, ai, undo, paragraphs, settle }
}

test("a sentence a page break cut in two is joined into one paragraph", async () => {
  const page = readerPage()
  page.answers.push(() => ({ paragraphs: ["of the page before.", "Next paragraph"], pages: { through: 10, total: 12 } }))
  page.next().click(); await page.settle()
  assert.deepEqual(page.paragraphs(), ["Garbled page one of the page before.", "Next paragraph"])
  page.answers.push(() => ({ paragraphs: ["Starts a new paragraph."], pages: { through: 12, total: 12 } }))
  page.next().click(); await page.settle()
  assert.deepEqual(page.paragraphs().slice(-2), ["Next paragraph", "Starts a new paragraph."], "a capitalized start keeps its own paragraph")
})

test("read to end takes part after part to the last page, and stops when asked", async () => {
  const page = readerPage()
  page.answers.push(
    () => ({ paragraphs: ["Pages six to ten."], pages: { through: 10, total: 12 } }),
    () => ({ paragraphs: ["Pages eleven and twelve."], pages: { through: 12, total: 12 } })
  )
  page.end().click()
  assert.equal(page.end().textContent, "Stop")
  for (let i = 0; i < 5; i++) await page.settle()
  assert.deepEqual(page.requests.map(request => request.pages), [{ from: 6, to: 10 }, { from: 11, to: 12 }])
  assert.deepEqual(page.paragraphs().slice(-2), ["Pages six to ten.", "Pages eleven and twelve."])
  assert.equal(page.footer().hidden, true)

  const stopped = readerPage()
  let release
  stopped.answers.push(request => new Promise(resolve => { release = () => resolve({ paragraphs: ["late"], pages: { through: 10, total: 12 } }) }))
  stopped.end().click(); await stopped.settle()
  stopped.end().click()
  release(); for (let i = 0; i < 3; i++) await stopped.settle()
  assert.equal(stopped.requests.length, 1, "no further part is asked for")
  assert.deepEqual(stopped.paragraphs(), ["Garbled page one"], "the stopped part is not shown")
  assert.equal(stopped.end().textContent, "Read to end")
})

test("a long scan continues on the device five pages at a time, then with the model after AI", async () => {
  const page = readerPage()
  assert.match(page.footer().textContent, /Pages 1–5 of 12/)
  assert.equal(page.next().textContent, "Next 5")

  page.answers.push(() => ({ paragraphs: ["Page six", "Page seven"], pages: { through: 10, total: 12 } }))
  page.next().click(); await page.settle()
  assert.deepEqual(page.requests.at(-1).pages, { from: 6, to: 10 })
  assert.equal(page.requests.at(-1).action, "pages")
  assert.deepEqual(page.paragraphs(), ["Garbled page one", "Page six", "Page seven"])
  assert.equal(page.next().textContent, "Next 2")

  // AI starts over from page 1 with the model, so its chunks replace the device text.
  page.answers.push(() => ({ html: "<h1>Real title</h1><p>Clean pages one to five</p>", model, generatedAt: "now", pages: { through: 5, total: 12 } }))
  page.ai().click(); await page.settle()
  const first = page.requests.at(-1)
  assert.equal(first.action, "rewrite")
  assert.deepEqual(first.pages, { from: 1, to: 5 })
  assert.equal(first.html, undefined, "a part is read from its pictures, not from the garbled extraction")
  assert.equal(page.document.querySelector("main h1").textContent, "Real title")
  assert.deepEqual(page.paragraphs(), ["Clean pages one to five"])
  assert.match(page.footer().textContent, /Pages 1–5 of 12 · AI/)

  page.answers.push(() => ({ html: "<h1>Repeated</h1><p>Clean pages six to ten.</p>", model, generatedAt: "now", pages: { through: 10, total: 12 } }))
  page.next().click(); await page.settle()
  const second = page.requests.at(-1)
  assert.deepEqual(second.pages, { from: 6, to: 10 })
  assert.match(second.previous, /Clean pages one to five$/)
  assert.deepEqual(page.paragraphs(), ["Clean pages one to five", "Clean pages six to ten."], "a later part appends without a second title")
  assert.equal(page.document.querySelector("main h1").textContent, "Real title")

  page.undo().click()
  assert.deepEqual(page.paragraphs(), ["Clean pages one to five"])
  assert.match(page.footer().textContent, /Pages 1–5 of 12 · AI/)
  page.undo().click()
  assert.deepEqual(page.paragraphs(), ["Garbled page one", "Page six", "Page seven"], "undo returns to the device pages")
  assert.match(page.footer().textContent, /Pages 1–10 of 12Next 2/)
  assert.equal(page.undo().hidden, true)

  page.answers.push(() => ({ paragraphs: ["Page eleven"], pages: { through: 12, total: 12 } }))
  page.next().click(); await page.settle()
  assert.equal(page.next().hidden, true, "nothing is left to continue")
  assert.equal(page.footer().hidden, true, "the row goes once every page is read")
})
