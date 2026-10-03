const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")
const { parseHTML } = require("linkedom")

const root = path.resolve(__dirname, "../../..")

// readerLinks.ts imports only the protocol module, so both transpile on their
// own and the protocol is handed in as the one resolvable require.
function loadModule(name, requireMap = {}) {
  const source = fs.readFileSync(path.join(root, `apps/mobile/src/${name}.ts`), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const moduleObject = { exports: {} }
  Function("exports", "module", "require", compiled)(
    moduleObject.exports, moduleObject, (id) => requireMap[id] ?? {}
  )
  return moduleObject.exports
}

const protocol = loadModule("readerLinkProtocol")
const links = loadModule("readerLinks", { "./readerLinkProtocol": protocol })

test("reader links are classified as in-page jumps, openable URLs or ignored", () => {
  const { classifyReaderLink } = protocol
  assert.deepEqual(classifyReaderLink("#fn%201"), { kind: "fragment", id: "fn 1" })
  assert.deepEqual(classifyReaderLink("#"), { kind: "fragment", id: "" })
  assert.deepEqual(classifyReaderLink("https://example.com/x#y"), { kind: "open", url: "https://example.com/x#y" })
  assert.deepEqual(classifyReaderLink("mailto:a@example.com"), { kind: "open", url: "mailto:a@example.com" })
  assert.deepEqual(classifyReaderLink("javascript:alert(1)"), { kind: "ignore" })
  assert.deepEqual(classifyReaderLink("/relative"), { kind: "ignore" }, "the sanitizer leaves no relative links")
  assert.deepEqual(classifyReaderLink(null), { kind: "ignore" })
})

function readerFrame(body) {
  const { window } = parseHTML(`<html><body>${body}</body></html>`)
  const posted = []
  window.parent = { postMessage: (message) => posted.push(message) }
  links.installReaderLinks(window)
  const tap = (selector) => {
    const event = new window.Event("click", { bubbles: true, cancelable: true })
    event.button = 0
    window.document.querySelector(selector).dispatchEvent(event)
    return event
  }
  return { window, posted, tap }
}

test("an in-article link scrolls the reader and never navigates the frame", () => {
  const { window, posted, tap } = readerFrame(
    '<a id="ref" href="#note"><sup>1</sup></a><p id="note">Note</p>'
  )
  const scrolled = []
  window.document.getElementById("note").scrollIntoView = () => scrolled.push("note")
  const event = tap("sup")
  assert.equal(event.defaultPrevented, true)
  assert.deepEqual(scrolled, ["note"])
  assert.deepEqual(posted, [])
})

test("an external link is handed to the host instead of loading in the frame", () => {
  const { posted, tap } = readerFrame('<a href="https://example.com/next">Next</a>')
  const event = tap("a")
  assert.equal(event.defaultPrevented, true)
  assert.deepEqual(posted, [protocol.readerLinkRequest("https://example.com/next")])
})

test("the host opens only what the reader frame itself sent", () => {
  const listeners = []
  const opened = []
  const readerWindow = {}
  links.installReaderLinkHost(
    (source) => source === readerWindow,
    (url) => opened.push(url),
    { addEventListener: (_type, listener) => listeners.push(listener) }
  )
  const send = (data, source = readerWindow) => listeners.forEach((listener) => listener({ data, source }))
  send(protocol.readerLinkRequest("https://example.com/a"))
  send(protocol.readerLinkRequest("https://example.com/b"), {})
  send(protocol.readerLinkRequest("javascript:alert(1)"))
  send({ type: "open", url: "https://example.com/c" })
  assert.deepEqual(opened, ["https://example.com/a"])
})

test("the sanitizer keeps same-article fragments bare and resolves the rest", () => {
  const { window } = parseHTML("<html><body></body></html>")
  globalThis.DOMParser = window.DOMParser
  const { articleFromStoredContent } = require("../../../packages/ui-web/dist/reader/extractArticle")
  const article = articleFromStoredContent(
    '<p><a href="#fn1">1</a> <a href="https://example.com/post#fn2">2</a>' +
    ' <a href="/other#x">3</a> <a href="https://example.com/post">4</a></p>',
    { title: "T" },
    "https://example.com/post"
  )
  const hrefs = [...article.content.matchAll(/href="([^"]*)"/g)].map((match) => match[1])
  assert.deepEqual(hrefs, ["#fn1", "#fn2", "https://example.com/other#x", "https://example.com/post"])
})
