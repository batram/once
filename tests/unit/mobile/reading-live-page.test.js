const test = require("node:test")
const assert = require("node:assert/strict")

const { LIVE_PAGE_SCRIPT } = require("../../../packages/app/dist/livePage")
const { ReadingSession } = require("../../../packages/ui-web/dist/ReadingSession")

global.document = { body: { classList: { toggle() {} } } }

const ARTICLE = "https://example.test/article"
const PAGE = { html: "<html lang=\"en\"><body><p>As the tab shows it</p></body></html>", url: ARTICLE }

// A surface answering scripts the way the native bridges do: with the value's JSON.
function surface(answer) {
  const listeners = new Map(), scripts = []
  return {
    scripts, listeners, available: true,
    async open() {}, async navigate() {}, async setBounds() {}, async setVisible() {}, async close() {},
    async evaluateJavaScript(script) { scripts.push(script); return typeof answer === "function" ? answer() : JSON.stringify(answer) },
    async pdfBytes(url) { return { bytes: new Uint8Array([37, 80, 68, 70]), url } },
    async addListener(event, listener) { listeners.set(event, listener); return () => listeners.delete(event) }
  }
}

const reader = () => ({ setVisible() {}, destroy() {}, close() {}, async open() {} })
const flush = () => new Promise(resolve => setImmediate(resolve))

async function openedTab(answer = PAGE) {
  const { ReadingSurfaceCoordinator } = await import("../../../apps/mobile/src/readingSurfaceCoordinator.ts")
  const session = new ReadingSession(), page = surface(answer)
  // Reader mode asks for the document through the loader; here it never answers.
  const coordinator = new ReadingSurfaceCoordinator(session, page, reader(),
    { getBoundingClientRect: () => ({ x: 0, y: 0, width: 320, height: 500 }) }, { load: () => new Promise(() => {}) })
  await coordinator.install()
  coordinator.setReadingPanelVisible(true)
  session.navigate(ARTICLE)
  await flush()
  return { session, page, coordinator }
}

function finish({ page }, url = ARTICLE) {
  page.listeners.get("navigationStarted")({ navigationId: 1, url })
  page.listeners.get("navigationFinished")({ navigationId: 1, url })
}

// What ReadingTabRuntime.surfaceShowing does over its tabs, for these coordinators.
function runtime(...tabs) {
  return {
    tabs: { selected: tabs[0] ?? null },
    pageSurface: tabs[0]?.page,
    surfaceShowing: url => tabs.find(tab => tab.coordinator.showsPage(url))?.page ?? null
  }
}

test("Reader mode reads the page it covers from the tab instead of downloading it again", async () => {
  const { livePageHtml } = await import("../../../apps/mobile/src/readingLivePage.ts")
  const tab = await openedTab()
  assert.equal(await livePageHtml(runtime(tab), ARTICLE), null, "a page still loading is not read")
  finish(tab)
  tab.session.setMode("reader")
  await flush()
  assert.equal(tab.session.snapshot().mode, "reader")
  assert.deepEqual(await livePageHtml(runtime(tab), `${ARTICLE}#comments`), PAGE)
  assert.deepEqual(tab.page.scripts, [LIVE_PAGE_SCRIPT])
})

test("a page that failed, moved on or was never opened is left to the download", async () => {
  const { livePageHtml } = await import("../../../apps/mobile/src/readingLivePage.ts")
  const failed = await openedTab()
  failed.page.listeners.get("navigationFailed")({ navigationId: 1, url: ARTICLE, message: "offline" })
  assert.equal(await livePageHtml(runtime(failed), ARTICLE), null)

  // Behind the reader the page went elsewhere by itself.
  const moved = await openedTab()
  finish(moved)
  moved.session.setMode("reader")
  await flush()
  finish(moved, "https://example.test/elsewhere")
  assert.equal(await livePageHtml(runtime(moved), ARTICLE), null)

  // The tab says it holds the page, the page itself says it is somewhere else by now.
  const stale = await openedTab({ ...PAGE, url: "https://example.test/later" })
  finish(stale)
  assert.equal(await livePageHtml(runtime(stale), ARTICLE), null)

  // An image or a PDF viewer answers null; a page with no script bridge rejects.
  const image = await openedTab(null)
  finish(image)
  assert.equal(await livePageHtml(runtime(image), ARTICLE), null)
  const unready = await openedTab(() => { throw new Error("The page is not ready to run scripts") })
  finish(unready)
  assert.equal(await livePageHtml(runtime(unready), ARTICLE), null)

  assert.equal(await livePageHtml(runtime(), ARTICLE), null)
  assert.deepEqual([failed, moved].flatMap(tab => tab.page.scripts), [], "a tab not holding the page is never asked")
})

test("another tab's page is read when the selected one holds something else", async () => {
  const { livePageHtml, livePagePdf } = await import("../../../apps/mobile/src/readingLivePage.ts")
  const selected = await openedTab({ ...PAGE, url: "https://example.test/other" })
  finish(selected, "https://example.test/other")
  const background = await openedTab()
  finish(background)
  assert.deepEqual(await livePageHtml(runtime(selected, background), ARTICLE), PAGE)
  assert.deepEqual(selected.page.scripts, [])
  // A viewer's load is checked natively, so with no tab known to hold the PDF the selected one is asked.
  assert.equal((await livePagePdf(runtime(selected, background), "https://example.test/report.pdf")).url, "https://example.test/report.pdf")
  assert.equal(await livePagePdf(runtime(), ARTICLE), null)
})
