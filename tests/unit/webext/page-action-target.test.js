const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const path = require("node:path")

function harness(sendMessage = () => Promise.resolve()) {
  const listeners = new Map()
  const calls = []
  const runtime = { id: "once", sendMessage: message => { calls.push(message); return sendMessage(message) } }
  class Anchor {
    constructor(href) { this.url = href }
    get href() { return this.url }
  }
  const context = vm.createContext({ exports: {}, require: name => {
    assert.equal(name, "webextension-polyfill")
    return { runtime }
  }, HTMLAnchorElement: Anchor, location: { href: "https://page.test/" }, document: {
    addEventListener: (type, listener, capture) => { assert.equal(capture, true); listeners.set(type, listener) },
    removeEventListener: (type, listener, capture) => { assert.equal(capture, true); assert.equal(listeners.get(type), listener); listeners.delete(type) }
  } })
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../../packages/webext-shell/dist/pageActionTarget.js"), "utf8"), context)
  return { runtime, listeners, calls, fire(type = "pointerover", href) {
    listeners.get(type)?.({ type, composedPath: () => href ? [new Anchor(href)] : [] })
  } }
}

test("reports the page or hovered link, deduplicating hover but not context menus", () => {
  const h = harness()
  h.fire()
  h.fire()
  h.fire("focusin", "https://link.test/")
  h.fire("contextmenu", "https://link.test/")
  assert.deepEqual(h.calls.map(call => call.href), ["https://page.test/", "https://link.test/", "https://link.test/"])
})

test("an unloaded extension detaches all listeners without attempting a message", () => {
  const h = harness()
  h.fire()
  h.runtime.id = undefined
  h.fire() // even when this URL would otherwise have been deduplicated
  assert.equal(h.listeners.size, 0)
  assert.equal(h.calls.length, 1)
})

test("synchronous context invalidation is contained and detaches the old script", () => {
  const h = harness(() => { throw new Error("Extension context invalidated.") })
  assert.doesNotThrow(() => h.fire())
  assert.equal(h.listeners.size, 0)
})

test("asynchronous context invalidation also detaches the old script", async () => {
  const h = harness(() => Promise.reject(new Error("Extension context invalidated.")))
  h.fire()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.listeners.size, 0)
})

test("a temporarily missing receiver leaves the live extension usable", async () => {
  const h = harness(() => Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")))
  h.fire()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.listeners.size, 3)
  h.fire("contextmenu")
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls.length, 2)
})

test("a runtime getter that throws during teardown is handled", () => {
  const h = harness()
  Object.defineProperty(h.runtime, "id", { get() { throw new Error("Extension context invalidated.") } })
  assert.doesNotThrow(() => h.fire())
  assert.equal(h.listeners.size, 0)
})
