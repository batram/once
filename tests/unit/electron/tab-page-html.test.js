const test = require("node:test")
const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

function load() {
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    "../../../apps/electron/src/tabPageHtml.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  Function("exports", "require", compiled)(module.exports, (name) => {
    if (name === "@once/app/livePage") return livePage
    throw Error(`no import of ${name}`)
  })
  return module.exports
}

const livePage = require("../../../packages/app/dist/livePage")

const ARTICLE = "https://example.com/article"

// One tab whose contents load until told otherwise.
function tabWindow({ loading, answer }) {
  const scripts = []
  const contents = Object.assign(new EventEmitter(), {
    loading,
    isLoading() { return this.loading },
    getURL: () => ARTICLE,
    executeJavaScript: async (script) => {
      scripts.push(script)
      return answer === undefined ? { html: "<html><body>The article</body></html>", url: `${ARTICLE}#top` } : answer
    }
  })
  const tab = { id: "t1", url: ARTICLE, loadError: null }
  return { tab, contents, scripts, tabs: { getAll: () => [tab], tabContents: () => contents } }
}

test("a tab's page is read with the shared page script, under the tab's own address", async () => {
  const { tabPageHtml } = load()
  const { tabs, scripts } = tabWindow({ loading: false })
  assert.deepEqual(await tabPageHtml(tabs, null, ARTICLE), { html: "<html><body>The article</body></html>", url: ARTICLE })
  assert.deepEqual(scripts, [livePage.LIVE_PAGE_SCRIPT])
})

test("a tab still loading the page is read once it finishes, not passed over for a fetch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { tabPageHtml } = load()
  const { tabs, contents } = tabWindow({ loading: true })
  const read = tabPageHtml(tabs, null, `${ARTICLE}#comments`)
  contents.loading = false
  contents.emit("did-stop-loading")
  assert.deepEqual(await read, { html: "<html><body>The article</body></html>", url: ARTICLE })
})

test("a load that keeps going is waited for, then given up for a fetch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { tabPageHtml } = load()
  const { tabs, contents } = tabWindow({ loading: true })
  const read = tabPageHtml(tabs, null, ARTICLE)
  // A redirect stops one load and starts the next.
  contents.emit("did-stop-loading")
  t.mock.timers.tick(5_000)
  assert.equal(await read, null)
  assert.equal(contents.listenerCount("did-stop-loading"), 0)
})

test("only an HTML document's markup is read; an image, PDF or text file in its wrapper is not", async () => {
  const { tabPageHtml } = load()
  const { tabs, contents } = tabWindow({ loading: false })
  for (const [contentType, expected] of [["text/html", "<html>page</html>"], ["application/xhtml+xml", "<html>page</html>"], ["image/png", null], ["application/pdf", null], ["text/plain", null]]) {
    // The script the tab runs, run here against a document of that type.
    contents.executeJavaScript = async (script) => Function("document", "location", `return ${script}`)({ contentType, documentElement: { outerHTML: "<html>page</html>" } }, { href: ARTICLE })
    const read = await tabPageHtml(tabs, null, ARTICLE)
    assert.equal(read?.html ?? null, expected, contentType)
  }
})

const PDF = "https://example.com/report.pdf"

function pdfTab(result) {
  const contents = Object.assign(new EventEmitter(), {
    isLoading: () => false,
    getURL: () => PDF,
    executeJavaScript: async (script) => typeof result === "function" ? result(script) : result
  })
  const tab = { id: "p1", url: PDF, loadError: null }
  return { tabs: { getAll: () => [tab], tabContents: () => contents } }
}

// The script the tab runs, run here against a document of that type and a
// fetch that answers each cache mode as told.
function pdfPage(contentType, answers) {
  const requests = []
  const fetch = async (url, options) => {
    requests.push({ url, ...options })
    const answer = answers[options.cache]
    if (!answer) throw new TypeError("Failed to fetch")
    return { ok: true, headers: { get: () => null }, arrayBuffer: async () => answer.buffer, ...answer.response }
  }
  const run = (script) => Function("document", "location", "fetch", `return ${script}`)({ contentType }, { href: PDF }, fetch)
  return { requests, run }
}

test("a PDF tab's bytes are read as the tab, from its HTTP cache before asking again", async () => {
  const { tabPdfBytes } = load()
  const bytes = new TextEncoder().encode("%PDF-1.7\n%body")
  const asTab = { url: PDF, mode: "same-origin", credentials: "include" }

  const cached = pdfPage("application/pdf", { "only-if-cached": bytes })
  assert.deepEqual(await tabPdfBytes(pdfTab(cached.run).tabs, null, `${PDF}#page=2`), { bytes, url: PDF })
  assert.deepEqual(cached.requests, [{ ...asTab, cache: "only-if-cached" }])

  // Not in the cache, or cached as a failure: the tab asks again.
  for (const miss of [undefined, { response: { ok: false } }]) {
    const asked = pdfPage("application/pdf", { "only-if-cached": miss, "no-cache": bytes })
    assert.deepEqual(await tabPdfBytes(pdfTab(asked.run).tabs, null, PDF), { bytes, url: PDF })
    assert.deepEqual(asked.requests, [{ ...asTab, cache: "only-if-cached" }, { ...asTab, cache: "no-cache" }])
  }

  const oversized = pdfPage("application/pdf", { "only-if-cached": { response: { headers: { get: () => String(65 * 1024 * 1024) } } } })
  assert.equal(await tabPdfBytes(pdfTab(oversized.run).tabs, null, PDF), null)

  const html = pdfPage("text/html", { "only-if-cached": bytes })
  assert.equal(await tabPdfBytes(pdfTab(html.run).tabs, null, PDF), null)
  assert.deepEqual(html.requests, [], "a tab showing something else is not asked for a PDF")
})

test("a cached challenge page, a non-PDF tab or no tab is not taken for the PDF", async () => {
  const { tabPdfBytes } = load()
  const challenge = pdfTab(new TextEncoder().encode("<!DOCTYPE html><title>Just a moment...</title>"))
  assert.equal(await tabPdfBytes(challenge.tabs, null, PDF), null)
  assert.equal(await tabPdfBytes(pdfTab(null).tabs, null, PDF), null)
  assert.equal(await tabPdfBytes(pdfTab(null).tabs, null, "https://example.com/other.pdf"), null)
  assert.equal(await tabPdfBytes(pdfTab(null).tabs, null, "file:///C:/report.pdf"), null)
})

test("a tab that fails, moves on or closes while it loads is not read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { tabPageHtml } = load()
  const failed = tabWindow({ loading: true })
  const read = tabPageHtml(failed.tabs, null, ARTICLE)
  failed.tab.loadError = "ERR_CONNECTION_RESET"
  failed.contents.loading = false
  failed.contents.emit("did-stop-loading")
  assert.equal(await read, null)

  const moved = tabWindow({ loading: true })
  const elsewhere = tabPageHtml(moved.tabs, null, ARTICLE)
  moved.tab.url = "https://example.com/another"
  moved.contents.loading = false
  moved.contents.emit("did-stop-loading")
  assert.equal(await elsewhere, null)

  const closed = tabWindow({ loading: true })
  const gone = tabPageHtml(closed.tabs, null, ARTICLE)
  closed.contents.emit("destroyed")
  assert.equal(await gone, null)
})
