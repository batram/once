const test = require("node:test")
const assert = require("node:assert/strict")
const { webextAddonConversations, CONVERSATION_PORT } = require("../../../packages/webext-shell/dist/addonConversations")

function event() {
  const listeners = []
  return { listeners, addListener(listener) { listeners.push(listener) }, removeListener() {} }
}

function port(name, url) {
  return { name, sender: { url }, posted: [], disconnected: false, onMessage: event(), onDisconnect: event(),
    postMessage(message) { this.posted.push(message) }, disconnect() { this.disconnected = true } }
}

test("the panel opens a tab named by the conversation and answers every port whose page names one it holds", async () => {
  const onConnect = event()
  const created = []
  const api = {
    runtime: { onConnect, getURL: path => `moz-extension://once/${path}` },
    tabs: { create: async options => { created.push(options); return { id: 1 } } }
  }
  const surface = webextAddonConversations(api)
  assert.equal(surface.label, "Continue in a tab")
  const sent = []
  let listener
  const snapshot = { addon: { id: "example", name: "A" }, tray: { id: "assistant", title: "T" }, story: { href: "https://story.test/", title: "S" }, view: { messages: [] } }
  const handle = { snapshot: () => snapshot, subscribe: next => { listener = next; return () => { listener = null } }, send: command => sent.push(command) }
  surface.connect(key => key.story === "https://story.test/" ? handle : null)
  surface.open(handle)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(created, [{ url: "moz-extension://once/static/addon-conversation.html?addon=example&tray=assistant&story=https%3A%2F%2Fstory.test%2F", active: true }])
  onConnect.listeners[0](port("something-else", created[0].url))
  const unknown = port(CONVERSATION_PORT, "moz-extension://once/static/addon-conversation.html?addon=example&tray=assistant&story=https%3A%2F%2Fother.test%2F")
  onConnect.listeners[0](unknown)
  assert.deepEqual(unknown.posted, [{ snapshot: null }])
  const page = port(CONVERSATION_PORT, created[0].url)
  onConnect.listeners[0](page)
  assert.deepEqual(page.posted, [{ snapshot }])
  listener({ ...snapshot, busy: true })
  assert.equal(page.posted.at(-1).snapshot.busy, true)
  page.onMessage.listeners[0]({ type: "submit", text: "Hello" })
  page.onMessage.listeners[0]({ type: "bogus" })
  assert.deepEqual(sent, [{ type: "submit", text: "Hello" }])
  page.onDisconnect.listeners[0]()
  assert.equal(listener, null)
  // The page navigated on and came back, or another tab opened the same URL: same conversation.
  const returned = port(CONVERSATION_PORT, created[0].url)
  onConnect.listeners[0](returned)
  assert.deepEqual(returned.posted, [{ snapshot }])
  assert.notEqual(listener, null)
})
