const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const source = fs.readFileSync(require.resolve("../../../scripts/ios-violentmonkey-compat"), "utf8")

function setup() {
  let receive
  let removed
  let icon
  const api = {
    permissions: Object.fromEntries(["contains", "request", "remove"].map(name => [name, async () => true])),
    webRequest: {}, browserAction: { setIcon: details => { icon = details; return Promise.resolve() } },
    runtime: { onMessage: { addListener: fn => { receive = fn } } },
    tabs: { onRemoved: { addListener: fn => { removed = fn } } }
  }
  const context = vm.createContext({ browser: api })
  vm.runInContext(source, context)
  return { api, context, receive: (...args) => receive(...args), removed: id => removed(id), icon: () => icon }
}

test("unsupported optional APIs fail explicitly while supported permissions and icons work", async () => {
  const host = setup()
  assert.equal(await host.api.permissions.contains({ permissions: ["downloads"] }), false)
  assert.equal(await host.api.permissions.request({ permissions: ["storage"] }), true)
  await assert.rejects(host.api.notifications.create("test", {}), /not supported/)
  const details = { path: "icon.png", imageData: { fake: true }, tabId: 1 }
  await host.api.browserAction.setIcon(details)
  assert.equal(host.icon().path, "icon.png")
  assert.equal("imageData" in host.icon(), false)
  assert.ok(details.imageData, "Don't mutate upstream's input")
  assert.equal(host.api.webRequest.OnHeadersReceivedOptions.EXTRA_HEADERS, undefined)
})

test("cold background restores only matched value stores without executing scripts", async () => {
  const host = setup()
  const calls = []
  const upstream = async (message, sender) => {
    calls.push({ message, sender })
    if (message.cmd === "GetMoreIds") return { 3: "more", 4: 0 }
    return "ok"
  }
  const restored = []
  host.context.onceRestoreValueOpeners = async (ids, tab, frame) => { restored.push({ ids: Array.from(ids), tab, frame }) }
  host.context.handleCommandMessage = upstream
  host.api.runtime.onMessage.addListener(upstream)
  const sender = { tab: { id: 1 }, frameId: 0, documentId: "first", url: "https://example.com/" }
  const message = { cmd: "UpdateValue", data: { 3: { count: "n1" } }, top: 1, url: "https://untrusted.invalid/" }
  await host.receive(message, sender)
  assert.deepEqual(calls.map(c => c.message.cmd), ["GetMoreIds", "UpdateValue"])
  assert.equal(calls[0].sender, undefined, "Matching is an internal background operation")
  assert.equal(calls[0].message.data.url, sender.url, "Recovery uses WebKit's sender URL")
  assert.deepEqual(restored, [{ ids: [3], tab: 1, frame: 0 }], "Only the script upstream matched is restored")
  calls.length = 0
  await host.receive(message, sender)
  assert.deepEqual(calls.map(c => c.message.cmd), ["UpdateValue"])
  assert.equal(restored.length, 1)
  calls.length = 0
  await host.receive(message, { ...sender, documentId: "second" })
  assert.deepEqual(calls.map(c => c.message.cmd), ["GetMoreIds", "UpdateValue"])
  assert.equal(restored.length, 2)
  calls.length = 0
  host.removed(1)
  await host.receive(message, sender)
  assert.equal(calls[0].message.cmd, "GetMoreIds")
  assert.equal(restored.length, 3)
})

test("normal injection and unrelated messages retain upstream dispatch behavior", async () => {
  const host = setup()
  const calls = []
  const upstream = message => { calls.push(message.cmd); return Promise.resolve() }
  host.context.handleCommandMessage = upstream
  host.api.runtime.onMessage.addListener(upstream)
  const sender = { tab: { id: 1 }, frameId: 0, documentId: "first", url: "https://example.com/" }
  await host.receive({ cmd: "GetInjected", data: {} }, sender)
  await host.receive({ cmd: "UpdateValue", data: {} }, sender)
  await host.receive({ cmd: "ExportZip" }, {})
  assert.deepEqual(calls, ["GetInjected", "UpdateValue", "ExportZip"])
})
