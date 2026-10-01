const test = require("node:test")
const assert = require("node:assert/strict")
const tick = () => new Promise(resolve => setImmediate(resolve))

function harness() {
  const entries = new Map()
  const saved = {}
  const sent = []
  let clicked, received, shown
  let panel
  const menus = {
    create(item) { entries.set(item.id, item) },
    async remove(id) { entries.delete(id) },
    async update(id, change) { Object.assign(entries.get(id), change) },
    async refresh() {},
    onShown: { addListener(listener) { shown = listener } },
    onClicked: { addListener(listener) { clicked = listener } }
  }
  const api = { menus, contextMenus: menus,
    storage: { local: { get: async () => saved, set: async values => Object.assign(saved, values) } },
    runtime: {
      onMessage: { addListener(listener) { received = listener } },
      async sendMessage(message) {
        sent.push(message)
        if (message.onceCommand === "page-actions-query") return panel
      }
    }
  }
  const restart = () => require("../../../packages/webext-shell/dist/pageActionMenuBackground").installPageActionMenuBackground(api)
  restart()
  return { entries, sent, restart,
    panel: value => { panel = value },
    receive: (value, sender = {}) => received(value, sender),
    click: (...args) => clicked(...args), show: (...args) => shown(...args) }
}
const state = (items, contextId = "panel-1") => ({ onceCommand: "page-actions-context", contextId, items })

test("page and link entries carry native target filters and respect conditions", async () => {
  const h = harness()
  await h.receive(state([
    { id: "example", label: "Example", when: { domain: ["*.example.test"], notDomain: ["blocked.example.test"], scheme: ["https"] } },
    { id: "story-only", label: "Story only", when: { type: ["HN"] } },
    { id: "bad", label: "Bad", when: { domain: "invalid" } }
  ]))
  assert.equal(h.entries.size, 2)
  assert.deepEqual(h.entries.get("once_page_example").documentUrlPatterns, ["https://*.example.test/*"])
  assert.deepEqual(h.entries.get("once_page_link:example").targetUrlPatterns, ["https://*.example.test/*"])
  await h.receive({ onceCommand: "page-actions-target", href: "https://blocked.example.test/" }, { tab: { id: 1 } })
  assert.equal(h.entries.get("once_page_example").enabled, false)
  h.show({ linkUrl: "https://ok.example.test/", pageUrl: "https://other.test/" })
  await tick()
  assert.equal(h.entries.get("once_page_link:example").enabled, true)
})

test("a retained menu finds a live panel after worker restart and routes page and link clicks", async () => {
  const h = harness()
  const items = [{ id: "example.explain", label: "Explain" }]
  await h.receive(state(items))
  h.restart()
  h.panel(state(items, "new-panel"))
  h.click({ menuItemId: "once_page_example.explain", pageUrl: "https://a.test/page" }, { title: "A page", windowId: 7 })
  h.click({ menuItemId: "once_page_link:example.explain", pageUrl: "https://a.test/page", linkUrl: "https://b.test/link", linkText: "The link" }, { windowId: 7 })
  await tick()
  assert.deepEqual(h.sent.filter(message => message.onceCommand === "page-addon-action"), [
    { onceCommand: "page-addon-action", action: "example.explain", contextId: "new-panel", href: "https://a.test/page", title: "A page" },
    { onceCommand: "page-addon-action", action: "example.explain", contextId: "new-panel", href: "https://b.test/link", title: "The link" }
  ])
  assert.ok(h.sent.filter(message => message.onceCommand === "page-actions-query").every(message => message.windowId === 7))
  await h.receive(state([]))
  assert.equal(h.entries.size, 0, "removed addons clear retained entries after a restart")
})

test("execution rechecks the live addon and its condition", async () => {
  const h = harness()
  h.panel(state([{ id: "example", label: "Example", when: { domain: ["example.test"] } }]))
  h.click({ menuItemId: "once_page_example", pageUrl: "https://other.test/" }, {})
  h.click({ menuItemId: "once_page_removed", pageUrl: "https://example.test/" }, {})
  await tick()
  assert.equal(h.sent.filter(message => message.onceCommand === "page-addon-action").length, 0)
})
