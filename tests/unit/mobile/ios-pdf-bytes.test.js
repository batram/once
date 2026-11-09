const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const ios = path.resolve(__dirname, "../../../apps/mobile/ios/App/App")
const download = fs.readFileSync(path.join(ios, "DocumentDownload.swift"), "utf8")

/** The tab script as WebKit runs it: an async function body with `limit` as its argument. */
function tabPdfScript() {
  const body = download.match(/tabPdfScript = """\n([\s\S]*?)\n\s*"""/)[1]
  return new Function("document", "location", "fetch", "limit", `return (async () => {\n${body}\n})()`)
}

const pdf = "%PDF-1.7 body"
const page = { contentType: "application/pdf" }
const location = { href: "https://example.test/report.pdf" }

test("iOS registers pdfBytes and reads the PDF as the tab, in the client world", () => {
  const plugin = fs.readFileSync(path.join(ios, "InAppBrowserSurfacePlugin.swift"), "utf8")
  assert.match(plugin, /CAPPluginMethod\(name: "pdfBytes"/)
  assert.match(download, /callAsyncJavaScript\(Self\.tabPdfScript, arguments: \["limit": limit\], in: nil, in: \.defaultClient\)/)
})

test("the tab's cached PDF is read first, and a miss asks again with the tab's cookies", async () => {
  const run = tabPdfScript()
  const asked = []
  const cached = async (url, init) => { asked.push(init.cache); return new Response(pdf) }
  assert.equal(atob(await run(page, location, cached, 1024)), pdf)
  assert.deepEqual(asked, ["only-if-cached"])

  asked.length = 0
  const miss = async (url, init) => {
    asked.push(init.cache)
    assert.equal(init.credentials, "include")
    if (init.cache === "only-if-cached") throw new TypeError("not cached")
    return new Response(pdf)
  }
  assert.equal(atob(await run(page, location, miss, 1024)), pdf)
  assert.deepEqual(asked, ["only-if-cached", "no-cache"])
})

test("no PDF comes back for a page, a challenge answer, or a file over the limit", async () => {
  const run = tabPdfScript()
  const never = async () => { throw new Error("an HTML page is never fetched") }
  assert.equal(await run({ contentType: "text/html" }, location, never, 1024), null)
  const challenge = async () => new Response("Just a moment...", { status: 200 })
  assert.equal(await run(page, location, challenge, 1024), null)
  assert.equal(await run(page, location, async () => new Response(pdf), 4), null)
})
