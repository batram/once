const test = require("node:test")
const assert = require("node:assert/strict")
const { webextAddonConversations, CONVERSATION_PORT } = require("../../../packages/webext-shell/dist/addonConversations")

function event() {
  const listeners = []
  return { listeners, addListener(listener) { listeners.push(listener) }, removeListener() {} }
}

function port(name) {
  return { name, posted: [], disconnected: false, onMessage: event(), onDisconnect: event(),
    postMessage(message) { this.posted.push(message) }, disconnect() { this.disconnected = true } }
}

test("the panel opens a tab per conversation and serves only ports that name a pending token", async () => {
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
  const snapshot = { addon: { id: "a", name: "A" }, view: { messages: [] } }
  surface.open({ snapshot: () => snapshot, subscribe: next => { listener = next; return () => { listener = null } }, send: command => sent.push(command) })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(created.length, 1)
  assert.equal(created[0].active, true)
  const token = new URL(created[0].url).searchParams.get("token")
  assert.match(created[0].url, /^moz-extension:\/\/once\/static\/addon-conversation\.html\?token=/)
  const stranger = port(`${CONVERSATION_PORT}unknown`)
  onConnect.listeners[0](stranger)
  assert.equal(stranger.disconnected, true)
  onConnect.listeners[0](port("something-else"))
  const page = port(`${CONVERSATION_PORT}${token}`)
  onConnect.listeners[0](page)
  assert.deepEqual(page.posted, [{ snapshot }])
  listener({ ...snapshot, busy: true })
  assert.equal(page.posted.at(-1).snapshot.busy, true)
  page.onMessage.listeners[0]({ type: "submit", text: "Hello" })
  page.onMessage.listeners[0]({ type: "bogus" })
  assert.deepEqual(sent, [{ type: "submit", text: "Hello" }])
  page.onDisconnect.listeners[0]()
  assert.equal(listener, null)
})
