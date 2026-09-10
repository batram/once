const assert = require("node:assert/strict")
const fs = require("node:fs")
const Module = require("node:module")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const originalTs = Module._extensions[".ts"]
Module._extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename
  }).outputText
  module._compile(output, filename)
}
test.after(() => {
  if (originalTs) Module._extensions[".ts"] = originalTs
  else delete Module._extensions[".ts"]
})

const root = path.resolve(__dirname, "../../..")
const { AddonConversationRelay, addonConversationUrl, isAddonConversationUrl } = require(path.join(root, "apps/electron/src/AddonConversationRelay.ts"))
const { ELECTRON_IPC } = require(path.join(root, "packages/platform-electron/dist/types.js"))

function contents(url) {
  const listeners = new Map()
  return {
    url, sent: [], destroyed: false,
    getURL() { return this.url },
    isDestroyed() { return this.destroyed },
    send(...args) { this.sent.push(args) },
    once(event, listener) { listeners.set(event, listener) },
    on(event, listener) { listeners.set(event, listener) },
    emit(event, ...args) { listeners.get(event)?.(...args) }
  }
}

test("conversation URLs carry a checked token and nothing else is one", () => {
  assert.equal(addonConversationUrl("abcd-1234"), "once-addon://conversation/index.html?token=abcd-1234")
  assert.throws(() => addonConversationUrl("../x"), /token/)
  assert.equal(isAddonConversationUrl("once-addon://conversation/index.html?token=a"), true)
  assert.equal(isAddonConversationUrl("once-addon://sandbox/index.html"), false)
  assert.equal(isAddonConversationUrl("https://example.test/once-addon://conversation/"), false)
})

test("the relay ties one shell and one tab per token and tells each about the other's end", async () => {
  const shell = contents("file:///shell.html")
  const tab = contents("once-addon://conversation/index.html?token=token-0001")
  const stranger = contents("once-addon://conversation/index.html?token=token-0001")
  const opened = []
  const relay = new AddonConversationRelay(async (owner, url) => { opened.push({ owner, url }); return tab })
  await relay.open(shell, "token-0001", { first: true })
  assert.deepEqual(opened, [{ owner: shell, url: "once-addon://conversation/index.html?token=token-0001" }])
  await assert.rejects(relay.open(shell, "token-0001", {}), /already open/)
  // Only the opened tab can connect or send; anyone else gets nothing.
  assert.deepEqual(relay.connect(tab, "token-0001"), { first: true })
  assert.equal(relay.connect(stranger, "token-0001"), null)
  assert.equal(relay.connect(tab, "token-0002"), null)
  relay.command(stranger, "token-0001", { type: "clear" })
  assert.equal(shell.sent.length, 0)
  relay.command(tab, "token-0001", { type: "clear" })
  assert.deepEqual(shell.sent.at(-1), [ELECTRON_IPC.addonsConversationCommand, "token-0001", { type: "clear" }])
  // Only the owning shell can push, and the tab hears it while it shows the page.
  relay.push(contents("file:///other.html"), "token-0001", { second: true })
  assert.equal(tab.sent.length, 0)
  relay.push(shell, "token-0001", { second: true })
  assert.deepEqual(tab.sent.at(-1), [ELECTRON_IPC.addonsConversationState, { second: true }, true])
  assert.deepEqual(relay.connect(tab, "token-0001"), { second: true })
  // Leaving the page ends the conversation for the shell; the tab is told it is on its own.
  tab.emit("did-navigate", {}, "https://elsewhere.test/")
  assert.deepEqual(shell.sent.at(-1), [ELECTRON_IPC.addonsConversationClosed, "token-0001"])
  tab.url = "https://elsewhere.test/"
  const count = tab.sent.length
  relay.push(shell, "token-0001", { third: true })
  assert.equal(tab.sent.length, count)
  assert.equal(relay.connect(tab, "token-0001"), null)
})

test("a destroyed shell leaves the tab read-only rather than silent", async () => {
  const shell = contents("file:///shell.html")
  const tab = contents("once-addon://conversation/index.html?token=token-0002")
  const relay = new AddonConversationRelay(async () => tab)
  await relay.open(shell, "token-0002", { view: 1 })
  shell.destroyed = true
  shell.emit("destroyed")
  assert.deepEqual(tab.sent.at(-1), [ELECTRON_IPC.addonsConversationState, { view: 1 }, false])
  relay.command(tab, "token-0002", { type: "clear" })
  assert.equal(shell.sent.length, 0)
})
