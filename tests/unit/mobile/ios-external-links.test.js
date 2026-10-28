const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const swift = fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/ios/App/App/InAppBrowserSurfaceNavigation.swift"), "utf8")
const source = swift.slice(swift.indexOf("final class ExternalLinkHandler:")).match(/static let source = """\n([\s\S]*?)\n {4}"""/)[1]

function fixture() {
  const messages = []
  let click
  class Anchor {
    constructor(href, target = "") { this.href = href; this.target = target }
    hasAttribute(name) { return name === "href" }
  }
  const document = { baseURI: "https://example.test/", querySelector: () => null }
  const window = {
    addEventListener(type, listener) { if (type === "click") click = listener },
    webkit: { messageHandlers: { onceExternalLink: { postMessage: url => messages.push(url) } } }
  }
  vm.runInNewContext(source, { window, document, HTMLAnchorElement: Anchor, URL })
  function emit(link, properties = {}) {
    const event = {
      isTrusted: true, defaultPrevented: false, button: 0,
      composedPath: () => [link].filter(Boolean),
      preventDefault() { this.defaultPrevented = true },
      stopImmediatePropagation() { this.stopped = true },
      ...properties
    }
    click(event)
    return event
  }
  return { messages, document, Anchor, emit }
}

test("only a trusted click on the actual app link requests a direct handoff", () => {
  const f = fixture()
  const link = new f.Anchor("sms:123")
  f.emit(link, { isTrusted: false })
  f.emit(link, { isTrusted: false, detail: 0 })
  assert.deepEqual(f.messages, [])
  const tap = f.emit(link)
  assert.equal(tap.defaultPrevented, true)
  assert.equal(tap.stopped, true)
  assert.deepEqual(f.messages, ["sms:123"])
  // A real click grants no permission to the next scripted click.
  f.emit(new f.Anchor("maps://elsewhere"), { isTrusted: false })
  assert.deepEqual(f.messages, ["sms:123"])
})

test("unrelated trusted clicks cannot authorize scripted anchors", () => {
  const f = fixture()
  f.emit(null)
  f.emit(new f.Anchor("https://example.test/"))
  f.emit(new f.Anchor("sms:123"), { isTrusted: false })
  assert.deepEqual(f.messages, [])
})

test("ordinary web links, internal URLs and frame targets retain their navigation behavior", () => {
  const f = fixture()
  for (const href of ["https://example.test/", "http://example.test/", "about:blank", "webkit-extension://host/page", "javascript:void(0)", "blob:https://example.test/id", "data:text/plain,hello", "file:///tmp/test"]) {
    assert.equal(f.emit(new f.Anchor(href)).defaultPrevented, false, href)
  }
  assert.equal(f.emit(new f.Anchor("sms:123", "child-frame")).defaultPrevented, false)
  f.document.querySelector = () => ({ target: "child-frame" })
  assert.equal(f.emit(new f.Anchor("sms:123")).defaultPrevented, false)
  assert.deepEqual(f.messages, [])
  assert.equal(f.emit(new f.Anchor("mailto:reader@example.test", "_blank")).defaultPrevented, true)
  assert.deepEqual(f.messages, ["mailto:reader@example.test"])
})

test("cancelled and secondary clicks do not launch another app", () => {
  const f = fixture()
  f.emit(new f.Anchor("sms:123"), { defaultPrevented: true })
  f.emit(new f.Anchor("sms:123"), { button: 1 })
  assert.deepEqual(f.messages, [])
})
