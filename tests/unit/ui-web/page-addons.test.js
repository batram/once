const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

const tick = () => new Promise(resolve => setImmediate(resolve))

function harness() {
  const previous = { document: global.document, CustomEvent: global.CustomEvent, Event: global.Event }
  const { document, CustomEvent, Event } = parseHTML("<html><body></body></html>")
  global.document = document
  global.CustomEvent = CustomEvent
  global.Event = Event
  const { AddonTrays } = require("../../../packages/ui-web/dist/addons/AddonTrays")
  const page = require("../../../packages/ui-web/dist/addons/pageAddons")
  const calls = []
  const opened = []
  const sandbox = {
    ensure: async () => ({
      tray: (_tray, event, story) => {
        calls.push({ event, story })
        return Promise.resolve({ messages: [{ role: "assistant", text: `About ${story.title}` }], composer: "Question" })
      }
    })
  }
  const make = surface => new AddonTrays({ id: "example", trays: [{ id: "assistant", title: "Assistant" }] }, sandbox, surface)
  // Mirrors what mountAddons registers for a tray action.
  const register = (trays, when = () => true, surfaces = ["button", "menu"]) => page.registerPageAction({
    id: "example.explain", label: "Explain", icon: "ai-question", surfaces,
    appliesTo: when,
    run: (target, how) => {
      if (how === "continue") return trays.continuePage(target, "assistant")
      trays.togglePage(target, "assistant")
      return true
    }
  })
  const restore = () => { Object.assign(global, previous) }
  return { document, page, make, register, calls, opened, restore, surface: { label: "Continue", open: handle => opened.push(handle) } }
}

test("a page with no row gets a tray of its own, drawn by page hosts, about the page as a story", async () => {
  const h = harness()
  try {
    const trays = h.make(h.surface)
    const release = h.register(trays)
    const host = h.document.createElement("div")
    const target = { href: "https://example.test/article", title: "  Example page " }
    assert.equal(h.page.runPageAddonAction("example.explain", target, "toggle"), true)
    await tick(); await tick()
    h.page.renderPageTrays(target.href, host)
    assert.equal(host.querySelector("section.addon_tray")?.getAttribute("aria-label"), "Assistant")
    assert.ok(host.textContent.includes("About Example page"))
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].event.type, "open")
    assert.deepEqual([h.calls[0].story.href, h.calls[0].story.title, h.calls[0].story.type], [target.href, "Example page", "page"])
    assert.equal(h.calls[0].story.domain, "example.test")

    // Toggling again closes it where the page is shown; the conversation stays.
    h.page.runPageAddonAction("example.explain", target, "toggle")
    h.page.renderPageTrays(target.href, host)
    assert.equal(host.childElementCount, 0)
    assert.equal(trays.handleFor("assistant", target.href).snapshot().view.messages[0].text, "About Example page")
    release()
    trays.dispose()
  } finally { h.restore() }
})

test("continuing a page opens the surface on a conversation started once, and is refused without a surface", async () => {
  const h = harness()
  try {
    const trays = h.make(h.surface)
    const release = h.register(trays)
    const target = { href: "https://example.test/one" }
    assert.equal(h.page.runPageAddonAction("example.explain", target, "continue"), true)
    await tick(); await tick()
    assert.equal(h.opened.length, 1)
    const snapshot = h.opened[0].snapshot()
    assert.deepEqual([snapshot.story.href, snapshot.story.title, snapshot.tray.id], [target.href, target.href, "assistant"])
    assert.equal(h.calls.length, 1, "a conversation that began is not restarted")
    h.page.runPageAddonAction("example.explain", target, "continue")
    assert.equal(h.opened.length, 2)
    assert.equal(h.calls.length, 1)
    release()
    trays.dispose()

    const bare = h.make(undefined)
    const releaseBare = h.register(bare)
    assert.equal(h.page.runPageAddonAction("example.explain", { href: "https://example.test/two" }, "continue"), false)
    releaseBare()
    bare.dispose()
  } finally { h.restore() }
})

// The reader picks, per add-on, whether page conversations open in a tab or
// in the Once panel beside the page; shells list the choice and run with it.
test("an add-on's page conversations open where the reader chose, a tab unless the panel was picked", async () => {
  const h = harness()
  const previousStorage = global.localStorage
  const stored = new Map()
  global.localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key) }
  try {
    const panelOpened = []
    const trays = h.make(h.surface)
    const release = h.page.registerPageAction({
      id: "addon:example/explain", label: "Explain", surfaces: ["menu"], converses: true, appliesTo: () => true,
      run: (target, how) => trays.continuePage(target, "assistant", how === "panel" ? { label: "Panel", open: handle => panelOpened.push(handle) } : undefined)
    })
    assert.equal(h.page.pageConversationPlace("example"), "tab")
    assert.equal(h.page.pageRunMode("addon:example/explain"), "continue")
    assert.equal(h.page.pageAddonActions("menu")[0].place, undefined)
    let announced = 0
    h.document.addEventListener(h.page.PAGE_ADDON_ACTIONS_CHANGED, () => announced++)
    h.page.setPageConversationPlace("example", "panel")
    assert.equal(announced, 1, "shells hear the change and republish their menus")
    assert.deepEqual(h.page.pageAddonActions("menu")[0], { id: "addon:example/explain", label: "Explain", icon: undefined, surfaces: ["menu"], converses: true, place: "panel" })
    assert.equal(h.page.pageRunMode("addon:example/explain"), "panel")
    assert.equal(h.page.runPageAddonAction("addon:example/explain", { href: "https://example.test/p" }, h.page.pageRunMode("addon:example/explain")), true)
    await tick()
    assert.deepEqual([panelOpened.length, h.opened.length], [1, 0], "the conversation opened in the panel, not a tab")
    h.page.setPageConversationPlace("example", "tab")
    assert.equal(stored.size, 0, "the default is not stored")
    assert.equal(h.page.pageRunMode("addon:example/explain"), "continue")
    release()
    trays.dispose()
  } finally { global.localStorage = previousStorage; h.restore() }
})

test("a listed page shares the story conversation while opening it in the reading host", async () => {
  const h = harness()
  try {
    const trays = h.make(h.surface)
    const release = h.register(trays)
    const row = h.document.createElement("story-item")
    row.story = { href: "https://story.test/", title: "Listed", type: "HN" }
    h.document.body.append(row)
    h.page.runPageAddonAction("example.explain", { href: "https://story.test/", title: "Ignored" }, "toggle")
    await tick(); await tick()
    assert.equal(trays.expanded(row, "assistant"), false)
    assert.equal(h.calls[0].story.title, "Listed")
    const host = h.document.createElement("div")
    h.page.renderPageTrays("https://story.test/", host)
    assert.equal(host.childElementCount, 1, "directly navigating to a listed URL still shows the page tray")
    release()
    trays.dispose()
  } finally { h.restore() }
})

test("comments and redirected pages render and continue the same listed conversation", async () => {
  const h = harness()
  try {
    const trays = h.make(h.surface)
    const release = h.register(trays)
    const row = h.document.createElement("story-item")
    row.story = { href: "https://original.test/article", comment_url: "https://forum.test/comments", title: "Listed", type: "HN" }
    row.dataset.redirected_url = "https://mirror.test/article"
    h.document.body.append(row)
    const host = h.document.createElement("div")
    for (const href of [row.story.comment_url, row.dataset.redirected_url, row.story.href]) {
      h.page.runPageAddonAction("example.explain", { href }, "toggle")
      await tick()
      h.page.renderPageTrays(href, host)
      assert.equal(host.childElementCount, 1)
      assert.ok(host.textContent.includes("Listed"))
      h.page.runPageAddonAction("example.explain", { href }, "continue")
      assert.equal(h.opened.at(-1).snapshot().story.href, row.story.href)
      h.page.runPageAddonAction("example.explain", { href }, "toggle")
      h.page.renderPageTrays(href, host)
      assert.equal(host.childElementCount, 0)
    }
    assert.equal(h.calls.length, 1, "aliases reuse the conversation")
    release()
    trays.dispose()
  } finally { h.restore() }
})

test("the registry lists what applies per surface, announces changes, and refuses what is not a web page", () => {
  const h = harness()
  try {
    const events = []
    h.document.addEventListener(h.page.PAGE_ADDON_ACTIONS_CHANGED, () => events.push(1))
    const trays = h.make(h.surface)
    const release = h.register(trays, target => target.href.includes("example"), ["menu"])
    assert.equal(events.length, 1)
    assert.deepEqual(h.page.pageAddonActions("menu"), [{ id: "example.explain", label: "Explain", icon: "ai-question", surfaces: ["menu"] }])
    assert.deepEqual(h.page.pageAddonActions("button"), [], "kept off the row's buttons, kept off the toolbar")
    assert.equal(h.page.pageAddonActions("menu", { href: "https://example.test/" }).length, 1)
    assert.equal(h.page.pageAddonActions("menu", { href: "https://other.test/" }).length, 0)
    assert.equal(h.page.pageAddonActions("menu", { href: "about:blank" }).length, 0)
    assert.equal(h.page.runPageAddonAction("example.explain", { href: "once-addon://conversation/index.html" }, "continue"), false)
    assert.equal(h.page.runPageAddonAction("example.explain", { href: "https://other.test/" }, "continue"), false)
    assert.equal(h.page.runPageAddonAction("missing", { href: "https://example.test/" }, "continue"), false)
    assert.equal(h.page.isAddonPage("https://example.test/"), true)
    assert.equal(h.page.isAddonPage("file:///tmp/x.html"), false)
    release()
    assert.equal(events.length, 2)
    assert.deepEqual(h.page.pageAddonActions("menu"), [])
    trays.dispose()
  } finally { h.restore() }
})

test("an action that is no tray runs on the page view wherever it was chosen", () => {
  const h = harness()
  try {
    const ran = []
    const release = h.page.registerPageAction({
      id: "example.copy", label: "Copy", surfaces: ["menu"],
      appliesTo: () => true,
      run: (target, how) => { ran.push([h.page.pageStoryView(target).title, how]); return true }
    })
    assert.equal(h.page.runPageAddonAction("example.copy", { href: "https://example.test/", title: "Titled" }, "continue"), true)
    assert.equal(h.page.runPageAddonAction("example.copy", { href: "https://example.test/" }, "toggle"), true)
    assert.deepEqual(ran, [["Titled", "continue"], ["https://example.test/", "toggle"]])
    release()
  } finally { h.restore() }
})
