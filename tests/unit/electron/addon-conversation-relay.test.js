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
const { AddonConversationRelay, isAddonConversationUrl } = require(path.join(root, "apps/electron/src/AddonConversationRelay.ts"))
const { ELECTRON_IPC } = require(path.join(root, "packages/platform-electron/dist/types.js"))

const PAGE = "once-addon://conversation/index.html?addon=example&tray=assistant&story=https%3A%2F%2Fstory.test%2F"
const KEY = { addon: "example", tray: "assistant", story: "https://story.test/" }

let nextId = 1
function contents(url) {
  const listeners = new Map()
  return {
    id: nextId++, url, sent: [], destroyed: false,
    getURL() { return this.url },
    isDestroyed() { return this.destroyed },
    send(...args) { this.sent.push(args) },
    once(event, listener) { listeners.set(event, listener) },
    on(event, listener) { listeners.set(event, listener) },
    removeListener(event, listener) { if (listeners.get(event) === listener) listeners.delete(event) },
    emit(event, ...args) { listeners.get(event)?.(...args) },
    listening(event) { return listeners.has(event) }
  }
}

function relayFor(shell, tab) {
  const opened = []
  const relay = new AddonConversationRelay({
    openTab: async (owner, url) => { opened.push({ owner, url }) },
    shellOf: candidate => candidate === tab ? shell : undefined
  })
  return { relay, opened }
}

test("only a page URL naming a conversation opens or counts as one", async () => {
  assert.equal(isAddonConversationUrl(PAGE), true)
  assert.equal(isAddonConversationUrl("once-addon://sandbox/index.html"), false)
  const shell = contents("file:///shell.html")
  const { relay, opened } = relayFor(shell, null)
  await relay.open(shell, PAGE)
  assert.deepEqual(opened, [{ owner: shell, url: PAGE }])
  assert.throws(() => relay.open(shell, "once-addon://conversation/index.html?addon=example"), /conversation page/)
  assert.throws(() => relay.open(shell, "https://example.test/"), /conversation page/)
})

test("a tab attaches to its window's shell by the page URL, leaves on navigation and comes back through history", () => {
  const shell = contents("file:///shell.html")
  const tab = contents(PAGE)
  const stranger = contents(PAGE)
  const { relay } = relayFor(shell, tab)
  relay.connect(tab)
  assert.deepEqual(shell.sent.at(-1), [ELECTRON_IPC.addonsConversationAttach, tab.id, KEY])
  // A tab of no window of ours gets nothing to attach to.
  relay.connect(stranger)
  assert.deepEqual(stranger.sent.at(-1), [ELECTRON_IPC.addonsConversationState, null, false])
  // The shell answers this tab only; the tab's input reaches this shell only.
  relay.push(contents("file:///other.html"), tab.id, { first: true })
  assert.equal(tab.sent.length, 0)
  relay.push(shell, tab.id, { first: true })
  assert.deepEqual(tab.sent.at(-1), [ELECTRON_IPC.addonsConversationState, { first: true }, true])
  relay.command(stranger, { type: "clear" })
  relay.command(tab, { type: "clear" })
  assert.deepEqual(shell.sent.at(-1), [ELECTRON_IPC.addonsConversationCommand, tab.id, { type: "clear" }])
  // Following a link detaches: the shell stops answering, nothing reaches the other page.
  tab.url = "https://elsewhere.test/"
  tab.emit("did-navigate")
  assert.deepEqual(shell.sent.at(-1), [ELECTRON_IPC.addonsConversationDetach, tab.id])
  assert.equal(tab.listening("did-navigate"), false)
  const count = tab.sent.length
  relay.push(shell, tab.id, { second: true })
  assert.equal(tab.sent.length, count)
  // Back through history the page asks again and attaches afresh.
  tab.url = PAGE
  relay.connect(tab)
  assert.deepEqual(shell.sent.at(-1), [ELECTRON_IPC.addonsConversationAttach, tab.id, KEY])
  relay.push(shell, tab.id, { third: true })
  assert.deepEqual(tab.sent.at(-1), [ELECTRON_IPC.addonsConversationState, { third: true }, true])
  // Closing the tab detaches too.
  tab.destroyed = true
  tab.emit("destroyed")
  assert.deepEqual(shell.sent.at(-1), [ELECTRON_IPC.addonsConversationDetach, tab.id])
})

test("a destroyed shell leaves the tab read-only rather than silent", () => {
  const shell = contents("file:///shell.html")
  const tab = contents(PAGE)
  const { relay } = relayFor(shell, tab)
  relay.connect(tab)
  shell.destroyed = true
  shell.emit("destroyed")
  assert.deepEqual(tab.sent.at(-1), [ELECTRON_IPC.addonsConversationState, null, false])
  relay.command(tab, { type: "clear" })
  assert.equal(shell.sent.filter(([channel]) => channel === ELECTRON_IPC.addonsConversationCommand).length, 0)
})
