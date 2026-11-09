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
  Function("exports", "require", compiled)(module.exports, () => { throw Error("no imports") })
  return module.exports
}

const ARTICLE = "https://example.com/article"

// One tab whose contents load until told otherwise.
function tabWindow({ loading }) {
  const contents = Object.assign(new EventEmitter(), {
    loading,
    isLoading() { return this.loading },
    getURL: () => ARTICLE,
    executeJavaScript: async () => "<html><body>The article</body></html>"
  })
  const tab = { id: "t1", url: ARTICLE, loadError: null }
  return { tab, contents, tabs: { getAll: () => [tab], tabContents: () => contents } }
}

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

const PDF = "https://example.com/report.pdf"

function pdfTab(result) {
  const scripts = []
  const contents = Object.assign(new EventEmitter(), {
    isLoading: () => false,
    getURL: () => PDF,
    executeJavaScript: async (script) => { scripts.push(script); return result }
  })
  const tab = { id: "p1", url: PDF, loadError: null }
  return { scripts, tabs: { getAll: () => [tab], tabContents: () => contents } }
}

test("a PDF tab's bytes are read as the tab, from its HTTP cache before asking again", async () => {
  const { tabPdfBytes } = load()
  const bytes = new TextEncoder().encode("%PDF-1.7\n%body")
  const { tabs, scripts } = pdfTab(bytes)
  assert.deepEqual(await tabPdfBytes(tabs, null, `${PDF}#page=2`), { bytes, url: PDF })
  assert.match(scripts[0], /document\.contentType !== "application\/pdf"/)
  assert.match(scripts[0], /credentials: "include"/)
  assert.match(scripts[0], /read\("only-if-cached"\) \?\? await read\("no-cache"\)/)
})

test("a cached challenge page, a non-PDF tab or no tab is not taken for the PDF", async () => {
  const { tabPdfBytes } = load()
  const challenge = pdfTab(new TextEncoder().encode("<!DOCTYPE html><title>Just a moment...</title>"))
  assert.equal(await tabPdfBytes(challenge.tabs, null, PDF), null)
  assert.equal(await tabPdfBytes(pdfTab(null).tabs, null, PDF), null)
  assert.equal(await tabPdfBytes(pdfTab(null).tabs, null, "https://example.com/other.pdf"), null)
  assert.equal(await tabPdfBytes(pdfTab(null).tabs, null, "file:///C:/report.pdf"), null)
})

test("a tab that fails or moves on while it loads is not read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { tabPageHtml } = load()
  const failed = tabWindow({ loading: true })
  const read = tabPageHtml(failed.tabs, null, ARTICLE)
  failed.tab.loadError = "ERR_CONNECTION_RESET"
  failed.contents.loading = false
  failed.contents.emit("did-stop-loading")
  assert.equal(await read, null)

  const closed = tabWindow({ loading: true })
  const gone = tabPageHtml(closed.tabs, null, ARTICLE)
  closed.contents.emit("destroyed")
  assert.equal(await gone, null)
})
