const test = require("node:test")
const assert = require("node:assert/strict")
const tick = () => new Promise(resolve => setImmediate(resolve))

function harness({ defaults, saved = {} } = {}) {
  const entries = new Map()
  const sent = []
  const opened = []
  let clicked, received, shown
  let panel
  let noListener = false
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
    tabs: { async create(properties) { opened.push(properties) } },
    runtime: {
      getURL: path => `moz-extension://once/${path.replace(/^\//, "")}`,
      onMessage: { addListener(listener) { received = listener } },
      async sendMessage(message) {
        sent.push(message)
        if (noListener) throw new Error("Could not establish connection. Receiving end does not exist.")
        if (message.onceCommand === "page-actions-query") return panel
      }
    }
  }
  const restart = () => {
    // A background restart starts from the menus the browser still holds; rebuilding them must be idempotent.
    require("../../../packages/webext-shell/dist/pageActionMenuBackground").installPageActionMenuBackground(api, defaults)
  }
  restart()
  return { entries, sent, opened, saved, restart,
    panel: value => { panel = value },
    noListener: () => { noListener = true },
    receive: (value, sender = { url: "moz-extension://once/static/sidepanel.html" }) => received(value, sender),
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
  await h.receive({ onceCommand: "page-actions-target", href: "https://blocked.example.test/" }, { tab: { id: 1 }, url: "https://blocked.example.test/" })
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

// A fresh install has never run a panel: the bundled add-ons' actions are in
// the menu anyway, and a panel's published list replaces them for good.
test("bundled actions are in the menu before any panel has published", async () => {
  const bundled = [{ id: "addon:wwww/explain", label: "Explain" }]
  const h = harness({ defaults: Promise.resolve(bundled) })
  for (let i = 0; i < 5; i++) await tick()
  assert.deepEqual([...h.entries.keys()].sort(), ["once_page_addon:wwww/explain", "once_page_link:addon:wwww/explain"])
  assert.deepEqual(h.entries.get("once_page_addon:wwww/explain").documentUrlPatterns, ["http://*/*", "https://*/*"])
  // The user removed every add-on in the panel: an empty list is a list, not a reason to bring defaults back.
  await h.receive(state([]))
  assert.equal(h.entries.size, 0)
  h.restart()
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(h.entries.size, 0)
})

test("every background start rebuilds the retained menu", async () => {
  const h = harness({ saved: { oncePageActionMenus: [{ id: "addon:kept/run", label: "Kept" }] }, defaults: [{ id: "addon:wwww/explain", label: "Explain" }] })
  for (let i = 0; i < 5; i++) await tick()
  assert.deepEqual([...h.entries.keys()].sort(), ["once_page_addon:kept/run", "once_page_link:addon:kept/run"])
  h.entries.clear() // a browser restart that did not keep the menus
  h.restart()
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(h.entries.get("once_page_addon:kept/run").title, "Kept")
})

// The entry outlives the panel that published it. With no panel in the
// clicked window, a conversation tab next to the page runs the action itself.
test("with no panel open, a click opens a conversation tab that runs the action", async () => {
  const h = harness()
  await h.receive(state([{ id: "addon:wwww/explain", label: "Explain", when: { domain: ["example.test"] } }]))
  h.restart()
  h.noListener()
  h.click({ menuItemId: "once_page_addon:wwww/explain", pageUrl: "https://example.test/a?b=1" }, { title: "A & B", windowId: 3, index: 4 })
  h.click({ menuItemId: "once_page_link:addon:wwww/explain", pageUrl: "https://x.test/", linkUrl: "https://example.test/l", linkText: "Link" }, { windowId: 3, index: 0 })
  h.click({ menuItemId: "once_page_addon:wwww/explain", pageUrl: "https://elsewhere.test/" }, { windowId: 3, index: 1 })
  h.click({ menuItemId: "once_page_addon:removed/x", pageUrl: "https://example.test/" }, { windowId: 3, index: 1 })
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(h.opened.length, 2, "only actions that still exist and apply open a tab")
  const [page, link] = h.opened.map(properties => ({ ...properties, url: new URL(properties.url) }))
  assert.equal(`${page.url.protocol}//${page.url.host}${page.url.pathname}`, "moz-extension://once/static/addon-conversation.html")
  assert.deepEqual(Object.fromEntries(page.url.searchParams), { run: "addon:wwww/explain", href: "https://example.test/a?b=1", title: "A & B" })
  assert.deepEqual([page.windowId, page.index, page.active], [3, 5, true])
  assert.deepEqual(Object.fromEntries(link.url.searchParams), { run: "addon:wwww/explain", href: "https://example.test/l", title: "Link" })
  assert.equal(h.sent.filter(message => message.onceCommand === "page-addon-action").length, 0)
})

test("rejects menu state from a content script or another extension page", async () => {
  const h = harness()
  const untrusted = state([{ id: "injected", label: "Injected" }])
  assert.equal(h.receive(untrusted, { tab: { id: 1 }, url: "https://example.test/" }), undefined)
  assert.equal(h.receive(untrusted, { url: "moz-extension://other/static/sidepanel.html" }), undefined)
  assert.equal(h.entries.size, 0)
})
