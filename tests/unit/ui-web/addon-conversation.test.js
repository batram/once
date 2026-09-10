const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

function dom(html) {
  const previous = { document: global.document, CustomEvent: global.CustomEvent, Event: global.Event, HTMLElement: global.HTMLElement }
  const window = parseHTML(html)
  global.document = window.document
  global.CustomEvent = window.CustomEvent
  global.Event = window.Event
  global.HTMLElement = window.HTMLElement
  return () => Object.assign(global, previous)
}

test("a tray hands out a conversation handle that mirrors its state and takes commands", async () => {
  const restore = dom('<html><body><div id="stories"></div></body></html>')
  const { AddonTrays } = require("../../../packages/ui-web/dist/addons/AddonTrays")
  const events = []
  let opened = null
  const trays = new AddonTrays({ id: "example", name: "Example", trays: [{ id: "assistant", title: "Assistant" }] }, {
    ensure: async () => ({ tray: async (_tray, event) => {
      events.push(event)
      if (event.type === "clear") return { messages: [] }
      const text = event.type === "submit" ? `Reply to ${event.text}` : event.type === "action" ? `Did ${event.action}` : "Opening answer"
      return { messages: [{ role: "assistant", text }], composer: "Question", actions: [{ id: "more", label: "More" }] }
    } })
  }, { label: "Continue", open: handle => { opened = handle } })
  const row = document.createElement("story-item")
  row.story = { href: "https://story.test/", title: "A story", type: "HN" }
  document.querySelector("#stories").append(row)
  const settle = () => new Promise(resolve => setImmediate(resolve))
  try {
    trays.toggle(row, "assistant")
    await settle()
    row.querySelector('[data-testid="addon-tray-continue"]').click()
    assert.ok(opened)
    const snapshots = []
    const release = opened.subscribe(snapshot => snapshots.push(snapshot))
    const first = opened.snapshot()
    assert.equal(first.addon.name, "Example")
    assert.equal(first.tray.title, "Assistant")
    assert.deepEqual(first.story, { href: "https://story.test/", title: "A story" })
    assert.equal(first.view.messages[0].text, "Opening answer")
    assert.equal(first.busy, false)
    opened.send({ type: "submit", text: "  a question " })
    assert.equal(snapshots.at(-1).busy, true)
    await settle()
    assert.equal(snapshots.at(-1).busy, false)
    assert.equal(snapshots.at(-1).view.messages[0].text, "Reply to a question")
    assert.match(row.querySelector(".addon_tray_message").textContent, /Reply to a question/)
    opened.send({ type: "action", action: "more" })
    await settle()
    assert.equal(events.at(-1).action, "more")
    // A draft typed on the page is remembered without redrawing the row.
    const composer = row.querySelector("textarea")
    opened.send({ type: "draft", text: "unsent" })
    assert.equal(row.querySelector("textarea"), composer)
    assert.equal(snapshots.at(-1).draft, "unsent")
    assert.equal(opened.snapshot().draft, "unsent")
    opened.send({ type: "clear" })
    await settle()
    assert.equal(events.at(-1).type, "clear")
    assert.equal(opened.snapshot().view.messages.length, 0)
    assert.equal(opened.snapshot().draft, "")
    release()
    const count = snapshots.length
    opened.send({ type: "draft", text: "unheard" })
    assert.equal(snapshots.length, count)
  } finally { trays.dispose(); restore() }
})

test("the conversation page renders snapshots, sends input and goes read-only without its shell", async () => {
  const restore = dom('<html><body><main id="root"></main></body></html>')
  const { mountAddonConversation } = require("../../../packages/ui-web/dist/addons/conversationPage")
  const sent = []
  let publish
  const snapshot = (overrides = {}) => ({
    addon: { id: "example", name: "Example" }, tray: { id: "assistant", title: "Assistant" },
    story: { href: "https://story.test/", title: "A story" },
    view: { messages: [{ role: "assistant", text: "**Answer**", sources: [{ title: "Source", url: "https://source.test/" }] }], composer: "Ask", actions: [{ id: "more", label: "More" }] },
    busy: false, error: "", draft: "", ...overrides
  })
  const root = document.querySelector("#root")
  const unmount = mountAddonConversation(root, { subscribe: listener => { publish = listener; return () => { publish = null } }, send: command => sent.push(command) })
  try {
    publish(snapshot(), true)
    assert.equal(document.title, "A story · Example")
    assert.equal(root.querySelector(".addon_conversation_story").href, "https://story.test/")
    assert.equal(root.querySelector(".addon_tray_assistant strong").textContent, "Answer")
    assert.equal(root.querySelector(".addon_tray_source").href, "https://source.test/")
    const button = label => Array.from(root.querySelectorAll("button")).find(item => item.textContent === label)
    button("More").click()
    assert.deepEqual(sent.at(-1), { type: "action", action: "more" })
    const input = root.querySelector("textarea")
    input.value = "Follow up"
    root.querySelector("form").dispatchEvent(new Event("submit", { cancelable: true }))
    assert.deepEqual(sent.at(-1), { type: "submit", text: "Follow up" })
    assert.equal(input.value, "")
    publish(snapshot({ busy: true }), true)
    assert.equal(input.disabled, true)
    assert.match(root.querySelector(".addon_tray_status").textContent, /Working/)
    button("Stop").click()
    assert.deepEqual(sent.at(-1), { type: "stop" })
    publish(snapshot({ error: "It broke", draft: "kept" }), true)
    assert.equal(input.value, "kept")
    assert.ok(root.querySelector(".addon_tray_status--error"))
    button("Retry").click()
    assert.deepEqual(sent.at(-1), { type: "retry" })
    // The shell went away: the transcript stays, the composer and actions do not.
    publish(null, false)
    assert.equal(root.dataset.connected, "false")
    assert.match(root.querySelector(".addon_conversation_notice").textContent, /panel/)
    assert.equal(root.querySelector(".addon_conversation_notice").hidden, false)
    assert.equal(input.disabled, true)
    assert.equal(button("Retry"), undefined)
    assert.match(root.querySelector(".addon_tray_assistant").textContent, /Answer/)
  } finally { unmount(); restore() }
})
