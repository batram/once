const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

function installDom() {
  const { window } = parseHTML("<html><body></body></html>")
  globalThis.window = window
  globalThis.document = window.document
  globalThis.HTMLElement = window.HTMLElement
  return window
}

test("mobile reader host replaces only the inert runtime marker", async () => {
  installDom()
  const requests = []
  globalThis.fetch = async (url) => {
    requests.push(url)
    return {
      ok: true,
      async text() { return "window.__readerRuntime = '</script-safe>'" }
    }
  }
  const { ReaderDocumentHost } = require(
    "../../../packages/ui-web/dist/reader/ReaderDocumentHost"
  )
  const host = new ReaderDocumentHost(document.body, "https://app/reader-runtime.js")

  await host.open(
    "<html><body><article>Story</article>" +
    "<script data-once-reader-runtime></script></body></html>"
  )

  const source = document.querySelector("iframe").srcdoc
  assert.deepEqual(requests, ["https://app/reader-runtime.js"])
  assert.doesNotMatch(source, /data-once-reader-runtime/)
  assert.match(source, /window\.__readerRuntime/)
  assert.match(source, /<\\\/script-safe>/, "closing script text is escaped")
})
