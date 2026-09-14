const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

test("cached documents reconnect native messaging and release old media listeners", () => {
  const events = new Map()
  const ports = []
  let mediaCleanups = 0
  const window = { addEventListener: (name, callback) => events.set(name, callback) }
  window.top = window
  const context = vm.createContext({
    window, location: { href: "https://example.test/", hostname: "example.test" },
    document: { readyState: "complete" }, setTimeout, clearTimeout,
    installOnceMediaBridge: () => () => { mediaCleanups++ },
    browser: { runtime: { connectNative() {
      const messages = []
      const port = {
        sent: [], closed: false,
        onMessage: { addListener: callback => messages.push(callback) },
        onDisconnect: { addListener() {} },
        disconnect() { this.closed = true },
        postMessage(message) { this.sent.push(message) },
        receive(message) { for (const callback of messages) callback(message) }
      }
      ports.push(port)
      return port
    } } }
  })
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,
    "../../../apps/mobile/extensions/once-surface/content.js"), "utf8"), context)
  assert.equal(ports.length, 1)
  ports[0].receive({ type: "health", id: 1 })
  assert.equal(ports[0].sent[0].restored, false)
  events.get("pagehide")({ persisted: true })
  assert.equal(ports[0].closed, true)
  assert.equal(mediaCleanups, 1)
  events.get("pageshow")({ persisted: true })
  assert.equal(ports.length, 2)
  ports[0].receive({ type: "health", id: 2 })
  assert.equal(ports[0].sent.length, 1, "Old ports must not respond")
  ports[1].receive({ type: "health", id: 3 })
  assert.equal(ports[1].sent[0].restored, true)
  ports[1].receive({ id: 4, code: "2 + 2" })
  assert.equal(ports[1].sent[1].value, "4")
  events.get("pageshow")({ persisted: true })
  assert.equal(ports.length, 2, "Repeated pageshow must not leak ports")
  events.get("pagehide")({ persisted: false })
  assert.equal(mediaCleanups, 2)
})
