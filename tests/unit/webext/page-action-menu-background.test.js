const test = require("node:test")
const assert = require("node:assert/strict")

const tick = () => new Promise(resolve => setImmediate(resolve))

function harness() {
  const created = []
  const removed = []
  let clicked
  let received
  const sent = []
  const menus = {
    create(item) { created.push(item) },
    async remove(id) { removed.push(id) },
    async update() {},
    onClicked: { addListener(listener) { clicked = listener } }
  }
  const browserApi = {
    contextMenus: menus,
    runtime: {
      getURL: path => `chrome-extension://once${path}`,
      onInstalled: { addListener() {} },
      onMessage: { addListener(listener) { received = listener } },
      async sendMessage(message) { sent.push(message) }
    }
  }
  const { installPageActionMenuBackground } = require("../../../packages/webext-shell/dist/pageActionMenuBackground")
  installPageActionMenuBackground(browserApi)
  return { created, removed, sent, click: (...args) => clicked(...args), receive: message => received(message) }
}

test("page actions become page and link menu items on web pages, following the panel's reports", async () => {
  const h = harness()
  h.receive({ onceCommand: "page-actions-context", contextId: "panel-1", items: [{ id: "example.explain", label: "Explain" }, { id: "bad" }] })
  await tick()
  assert.equal(h.created.length, 1)
  assert.equal(h.created[0].id, "once_page_example.explain")
  assert.equal(h.created[0].title, "Explain")
  assert.deepEqual(h.created[0].contexts, ["page", "link"])
  assert.deepEqual(h.created[0].documentUrlPatterns, ["http://*/*", "https://*/*"])
  assert.deepEqual(h.removed, ["once_page_example.explain"], "created over whatever an earlier worker left")

  // Same item again: nothing recreated. A relabel recreates it; a dropped one goes.
  h.receive({ onceCommand: "page-actions-context", contextId: "panel-1", items: [{ id: "example.explain", label: "Explain" }] })
  await tick()
  assert.equal(h.created.length, 1)
  h.receive({ onceCommand: "page-actions-context", contextId: "panel-1", items: [{ id: "example.explain", label: "Explain more" }, { id: "other", label: "Other" }] })
  await tick()
  assert.deepEqual(h.created.slice(1).map(item => item.title), ["Explain more", "Other"])
  h.receive({ onceCommand: "page-actions-context", contextId: "panel-1", items: [] })
  await tick()
  assert.deepEqual(h.removed.slice(-2).sort(), ["once_page_example.explain", "once_page_other"])
})

test("a click reports the link under the cursor, else the page, to the panel that listed the action", async () => {
  const h = harness()
  h.click({ menuItemId: "once_page_example.explain", pageUrl: "https://a.test/page" }, { title: "A page" })
  assert.equal(h.sent.length, 0, "nothing before a panel reported")
  h.receive({ onceCommand: "page-actions-context", contextId: "panel-2", items: [{ id: "example.explain", label: "Explain" }] })
  await tick()
  h.click({ menuItemId: "once_page_example.explain", pageUrl: "https://a.test/page" }, { title: "A page" })
  h.click({ menuItemId: "once_page_example.explain", pageUrl: "https://a.test/page", linkUrl: "https://a.test/link", linkText: "The link" }, { title: "A page" })
  h.click({ menuItemId: "once_story_open", pageUrl: "https://a.test/page" }, { title: "A page" })
  assert.deepEqual(h.sent, [
    { onceCommand: "page-addon-action", action: "example.explain", contextId: "panel-2", href: "https://a.test/page", title: "A page" },
    { onceCommand: "page-addon-action", action: "example.explain", contextId: "panel-2", href: "https://a.test/link", title: "The link" }
  ])
})
