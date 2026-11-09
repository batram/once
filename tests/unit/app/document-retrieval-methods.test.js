const test = require("node:test")
const assert = require("node:assert/strict")
const { documentRetrievalMethods } = require("../../../packages/app/dist/documentRetrievalMethods")

const html = async (url) => new Response("<!doctype html><p>Body</p>", { headers: { "content-type": "text/html" } , status: 200 })

test("documents are fetched through the platform's bounded document fetch when it has one", async () => {
  const used = []
  const platform = {
    fetch: async (url) => { used.push(["fetch", url]); return html(url) },
    documentFetch: async (url) => { used.push(["documentFetch", url]); return html(url) }
  }
  const result = await documentRetrievalMethods(platform).retrieveDocument("https://example.test/article")
  assert.equal(result.kind, "html")
  assert.deepEqual(used, [["documentFetch", "https://example.test/article"]])
  const plain = []
  await documentRetrievalMethods({ fetch: async (url) => { plain.push(url); return html(url) } }).fetchDocument("https://example.test/article")
  assert.deepEqual(plain, ["https://example.test/article"])
})

test("the open-tab fetch prefers the tab and otherwise uses the bounded document fetch", async () => {
  const { openDocumentFetch } = require("../../../packages/app/dist/documentRetrievalMethods")
  const used = []
  const bytes = new TextEncoder().encode("%PDF-1.7")
  const platform = {
    fetch: async (url) => { used.push(["fetch", url]); return html(url) },
    documentFetch: async (url) => { used.push(["documentFetch", url]); return html(url) },
    livePage: { html: async () => null, pdf: async (url) => url.endsWith(".pdf") ? { bytes, url } : null }
  }
  const fetch = openDocumentFetch(platform)
  const tab = await fetch("https://example.test/report.pdf")
  assert.equal(tab.headers.get("content-type"), "application/pdf")
  assert.equal(new TextDecoder().decode(await tab.arrayBuffer()), "%PDF-1.7")
  await fetch("https://example.test/article")
  assert.deepEqual(used, [["documentFetch", "https://example.test/article"]])
  assert.equal(openDocumentFetch({ fetch: platform.fetch }), platform.fetch, "no tab port, no wrapper")
})

test("a page an open tab shows is read as the tab rendered it, without asking the network", async () => {
  const used = []
  const platform = {
    fetch: async (url) => { used.push(["fetch", url]); return new Response("Forbidden", { status: 403 }) },
    livePage: {
      html: async (url) => url.endsWith("/article") ? { html: "<!doctype html><title>Open</title><p>As the tab shows it</p>", url: `${url}?redirected` } : null,
      pdf: async () => null
    }
  }
  const methods = documentRetrievalMethods(platform)
  const page = await methods.retrieveDocument("https://example.test/article")
  assert.equal(page.kind, "html")
  assert.match(page.html, /As the tab shows it/)
  assert.equal(page.url, "https://example.test/article?redirected", "the tab's own address, redirects included")
  assert.deepEqual(used, [], "a site refusing other requests (HTTP 403) is never asked")
  await assert.rejects(methods.fetchDocument("https://example.test/elsewhere"), /HTTP 403/, "without an open tab the download goes ahead")
  assert.deepEqual(used, [["fetch", "https://example.test/elsewhere"]])
})

test("a PDF an open tab shows is read from that tab instead of fetched again", async () => {
  const used = []
  const bytes = new TextEncoder().encode("%PDF-1.7")
  const platform = {
    fetch: async (url) => { used.push(["fetch", url]); return html(url) },
    livePage: {
      html: async () => null,
      pdf: async (url) => { used.push(["tab", url]); return url.endsWith(".pdf") ? { bytes, url } : null }
    },
    pdfText: { extract: async (received) => {
      used.push(["extract", new TextDecoder().decode(received)])
      return { pages: [{ method: "embedded", lines: ["Page text"] }] }
    } }
  }
  const methods = documentRetrievalMethods(platform)
  const pdf = await methods.retrieveDocument("https://example.test/report.pdf")
  assert.equal(pdf.kind, "text")
  assert.equal(pdf.url, "https://example.test/report.pdf")
  await methods.fetchDocument("https://example.test/article")
  assert.deepEqual(used, [
    ["tab", "https://example.test/report.pdf"],
    ["extract", "%PDF-1.7"],
    ["tab", "https://example.test/article"],
    ["fetch", "https://example.test/article"]
  ])
})
