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
const { electronAddonConversations } = require(path.join(root, "apps/electron/src/addonConversations.ts"))

function bridge() {
  const calls = { opened: [], pushed: [] }
  const handlers = {}
  return {
    calls, handlers,
    api: { addons: { conversations: {
      open: async url => { calls.opened.push(url) },
      push: (tabId, snapshot) => { calls.pushed.push({ tabId, snapshot }) },
      onAttach: handler => { handlers.attach = handler; return () => {} },
      onDetach: handler => { handlers.detach = handler; return () => {} },
      onCommand: handler => { handlers.command = handler; return () => {} }
    } } }
  }
}

test("the renderer opens a page named by the conversation and answers tabs that ask for it", async () => {
  const { api, calls, handlers } = bridge()
  const surface = electronAddonConversations(api)
  const sent = []
  let listener = null
  const snapshot = { addon: { id: "example", name: "A" }, tray: { id: "assistant", title: "T" }, story: { href: "https://story.test/", title: "S" }, view: { messages: [] } }
  const handle = { snapshot: () => snapshot, subscribe: next => { listener = next; return () => { listener = null } }, send: item => sent.push(item) }
  surface.open(handle)
  await new Promise(resolve => setImmediate(resolve))
  const url = "once-addon://conversation/index.html?addon=example&tray=assistant&story=https%3A%2F%2Fstory.test%2F"
  assert.deepEqual(calls.opened, [url])
  assert.equal(surface.storyHref(url), "https://story.test/")
  assert.equal(surface.storyHref("https://story.test/"), null)
  // Until the shell has said how to find conversations, tabs get nothing.
  handlers.attach(7, { addon: "example", tray: "assistant", story: "https://story.test/" })
  assert.deepEqual(calls.pushed.at(-1), { tabId: 7, snapshot: null })
  const asked = []
  surface.connect(key => { asked.push(key); return key.story === "https://story.test/" ? handle : null })
  handlers.attach(7, { addon: "example", tray: "assistant", story: "https://story.test/" })
  assert.deepEqual(asked.at(-1), { addon: "example", tray: "assistant", story: "https://story.test/" })
  assert.deepEqual(calls.pushed.at(-1), { tabId: 7, snapshot })
  listener({ ...snapshot, busy: true })
  assert.equal(calls.pushed.at(-1).snapshot.busy, true)
  handlers.command(7, { type: "submit", text: "Hi" })
  handlers.command(7, { type: "bogus" })
  handlers.command(8, { type: "clear" })
  assert.deepEqual(sent, [{ type: "submit", text: "Hi" }])
  handlers.attach(9, { addon: "example", tray: "assistant", story: "https://other.test/" })
  assert.deepEqual(calls.pushed.at(-1), { tabId: 9, snapshot: null })
  handlers.attach(9, "garbage")
  assert.deepEqual(calls.pushed.at(-1), { tabId: 9, snapshot: null })
  handlers.detach(7)
  assert.equal(listener, null)
  handlers.command(7, { type: "clear" })
  assert.equal(sent.length, 1)
})
