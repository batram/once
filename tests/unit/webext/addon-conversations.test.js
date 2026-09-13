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
  const openedUrl = new URL(created[0].url)
  assert.ok(openedUrl.searchParams.get("owner"))
  assert.equal(created[0].active, true)
  assert.equal(surface.storyHref(created[0].url), snapshot.story.href)
  assert.equal(surface.storyHref(created[0].url.replace("moz-extension://once/", "https://unrelated.test/")), null)
  assert.equal(surface.storyHref(created[0].url.replace("addon-conversation.html", "sidepanel.html")), null)
  const otherPanel = webextAddonConversations(api)
  otherPanel.connect(() => { throw new Error("A non-owner must not look up this conversation") })
  const unwanted = port(CONVERSATION_PORT, created[0].url)
  onConnect.listeners[1](unwanted)
  assert.deepEqual(unwanted.posted, [])
  assert.equal(unwanted.onMessage.listeners.length, 0)
  onConnect.listeners[0](port("something-else", created[0].url))
  const unknown = port(CONVERSATION_PORT, created[0].url.replace("story.test", "other.test"))
  onConnect.listeners[0](unknown)
  assert.deepEqual(unknown.posted, [{ snapshot: null }])
  const page = port(CONVERSATION_PORT, created[0].url)
  onConnect.listeners[0](page)
  assert.deepEqual(page.posted, [{ snapshot }])
  listener({ ...snapshot, busy: true })
  assert.equal(page.posted.at(-1).snapshot.busy, true)
  listener(null)
  assert.deepEqual(page.posted.at(-1), { snapshot: null }, "the owner may still end a conversation")
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
