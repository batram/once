const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { mountRemoteTabs } = require("../../../packages/ui-web/dist/tabsync/RemoteTabsView")

const settle = () => new Promise((resolve) => setImmediate(resolve))
const now = new Date().toISOString()
const tab = (id, url, title, mode = "web") => ({ id, navSeq: 1, url, title, mode, active: false,
  openedAt: now, navigatedAt: now, selectedAt: now, activityAt: now })
const device = (deviceId, name, windows, fields = {}) => ({ deviceId, name, platform: "android", sharing: true,
  updatedAt: now, stale: false, windows, ...fields })

function view(devices, inbox = [], options = { enabled: true }) {
  return { available: true, canShare: false, self: null, options, shared: {}, devices, notice: null, inbox }
}

function withDocument(run) {
  return async () => {
    const { document, window } = parseHTML("<html><body><div id='root'></div><div id='inbox'></div></body></html>")
    const previous = global.document
    global.document = document
    try {
      await run(document, window)
    } finally {
      global.document = previous
    }
  }
}

// linkedom has no MouseEvent; the view reads only the modifier keys.
const click = (window, modifiers = {}) => Object.assign(new window.Event("click", { bubbles: true, cancelable: true }), modifiers)

test("lists devices and windows, filters, opens in front or behind, and keeps rows across updates", withDocument(async (document, window) => {
  const listeners = new Set()
  let state = { connected: true, view: view([
    device("a", "Phone", [{ id: "w", focused: true, tabs: [{ ...tab("1", "https://news.example/a", "Alpha", "reader"), thumb: { id: "tth_x_1", w: 320, h: 200 } },
      tab("2", "https://www.video.example/b", "Beta")] }]),
    device("b", "Laptop", [
      { id: "w1", focused: true, tabs: [tab("3", "https://docs.example/c", "Gamma")] },
      { id: "w2", focused: false, tabs: [tab("4", "https://docs.example/d", "Delta")] }
    ])
  ]) }
  const opened = []
  const thumbnailRequests = []
  const menus = []
  const root = document.querySelector("#root")
  const handle = mountRemoteTabs(root, {
    load: async () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    open: (item, background) => opened.push([item.url, background]),
    thumbnail: async (id) => { thumbnailRequests.push(id); return "data:image/jpeg;base64,AAAA" },
    showMenu: async (anchor, items) => { menus.push(items.map((item) => item.id)); return "background" }
  })
  await settle()
  await settle()
  const images = () => [...root.querySelectorAll(".remote_tab_preview img")]
  assert.deepEqual(images().map((image) => image.getAttribute("src")), ["data:image/jpeg;base64,AAAA"])
  assert.equal(root.querySelectorAll(".remote_tab_preview")[1].textContent, "V", "a tab without a screenshot shows its site's initial")
  const devices = () => [...root.querySelectorAll("[data-testid=remote-device]")]
  assert.deepEqual(devices().map((section) => section.querySelector(".remote_device_name").textContent), ["Phone", "Laptop"])
  assert.match(devices()[0].textContent, /news\.example · Reader/)
  assert.equal(devices()[1].querySelectorAll(".remote_window_heading").length, 2, "two windows are labelled")
  assert.equal(devices()[0].querySelectorAll(".remote_window_heading").length, 0, "one window needs no label")
  assert.ok(devices()[0].querySelector(".remote_device_header .remote_open_all"), "one window's Open all sits with its device")

  const links = () => [...root.querySelectorAll(".remote_tab_link")]
  links()[0].dispatchEvent(click(window))
  links()[1].dispatchEvent(click(window, { ctrlKey: true }))
  root.querySelector(".remote_tab_more").click()
  await settle()
  assert.deepEqual(menus, [["background"]], "a row's menu without sending or copying offers only the background")
  assert.deepEqual(opened, [["https://news.example/a", false], ["https://www.video.example/b", true], ["https://news.example/a", true]])

  const picture = images()[0]
  devices()[0].querySelector(".remote_device_toggle").click()
  assert.equal(devices()[0].querySelectorAll(".remote_tab").length, 0, "a folded device hides its tabs")
  devices()[0].querySelector(".remote_device_toggle").click()
  state = { ...state, view: view([...state.view.devices, device("c", "Tablet", [], { sharing: false })]) }
  listeners.forEach((listener) => listener())
  await settle()
  // Compared by identity: printing a DOM node in a failure would never end.
  assert.ok(images()[0] === picture, "folding, unfolding and an update keep the row and its picture, so nothing blinks")
  assert.deepEqual(thumbnailRequests, ["tth_x_1"], "a screenshot is fetched once")
  assert.equal(devices().at(-1).querySelector(".remote_device_name").textContent, "Tablet", "a quiet device goes last")
  assert.doesNotMatch(devices().at(-1).textContent, /Not sharing its tabs/, "and starts folded")
  devices().at(-1).querySelector(".remote_device_toggle").click()
  assert.match(devices().at(-1).textContent, /Not sharing its tabs/)

  const filter = root.querySelector("[data-testid=remote-tabs-filter]")
  filter.value = "delta"
  filter.dispatchEvent(new window.Event("input"))
  assert.deepEqual(devices().map((section) => section.querySelector(".remote_device_name").textContent), ["Laptop"])
  assert.deepEqual(links().map((link) => link.getAttribute("href")), ["https://docs.example/d"])
  filter.value = "nothing at all"
  filter.dispatchEvent(new window.Event("input"))
  assert.match(root.textContent, /No tabs match “nothing at all”/)
  handle.dispose()
}))

test("the device rail narrows the list to one device and back", withDocument(async (document) => {
  let state = { connected: true, view: view([
    device("a", "Phone", [{ id: "w", focused: true, tabs: [tab("1", "https://news.example/a", "Alpha")] }]),
    device("b", "Laptop", [{ id: "w1", focused: true, tabs: [tab("2", "https://docs.example/c", "Gamma"), tab("3", "https://docs.example/d", "Delta")] }])
  ]) }
  const listeners = new Set()
  const root = document.querySelector("#root")
  mountRemoteTabs(root, { load: async () => state, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) }, open: () => undefined })
  await settle()
  await settle()
  const chips = () => [...root.querySelectorAll("[data-testid=remote-tabs-chip]")]
  const names = () => [...root.querySelectorAll("[data-testid=remote-device] .remote_device_name")].map((name) => name.textContent)
  assert.deepEqual(chips().map((chip) => chip.textContent), ["All devices3", "Phone1", "Laptop2"])
  assert.match(root.querySelector(".remote_tabs_summary").textContent, /2 devices · 3 tabs/)
  chips()[2].click()
  assert.deepEqual(names(), ["Laptop"])
  assert.equal(chips()[2].getAttribute("aria-pressed"), "true")
  state = { ...state, view: view([state.view.devices[0]]) }
  listeners.forEach((listener) => listener())
  await settle()
  assert.deepEqual(names(), ["Phone"], "a chosen device that goes away shows the rest again")
  assert.ok(root.querySelector("[data-testid=remote-tabs-rail]").hidden, "one device needs no rail")
}))

test("explains what is missing instead of showing an empty list, with a way to fix it", withDocument(async (document) => {
  const pages = []
  const root = document.querySelector("#root")
  let state = { connected: false, view: view([]) }
  const listeners = new Set()
  mountRemoteTabs(root, { load: async () => state, subscribe: (listener) => { listeners.add(listener); return () => undefined },
    open: () => undefined, openSettings: (page) => { pages.push(page) } })
  await settle()
  assert.match(root.textContent, /Connect sync to see tabs from your other devices/)
  root.querySelector(".remote_tabs_notice button").click()
  state = { connected: true, view: view([], [], { enabled: false }) }
  listeners.forEach((listener) => listener())
  await settle()
  assert.match(root.textContent, /Tab sync is off on this device/)
  root.querySelector(".remote_tabs_notice button").click()
  state = { connected: true, view: view([]) }
  listeners.forEach((listener) => listener())
  await settle()
  assert.match(root.textContent, /No other devices yet/)
  root.querySelector(".remote_tabs_notice button").click()
  assert.deepEqual(pages, ["tabs", "tabs", "pair"])
}))

test("tabs sent here come first (or where the shell lists them), open or go away; listed tabs are sent elsewhere", withDocument(async (document, window) => {
  const calls = []
  const offered = []
  const root = document.querySelector("#root")
  const inboxHost = document.querySelector("#inbox")
  const inbox = [{ id: "tsend_1", fromName: "Laptop", url: "https://sent.example/", title: "Sent page", mode: "web", createdAt: now }]
  const choices = ["send", "b"]
  mountRemoteTabs(root, {
    load: async () => ({ connected: true, view: view([
      device("a", "Phone", [{ id: "w", focused: true, tabs: [tab("1", "https://x.example/", "X")] }]),
      device("b", "Laptop", [{ id: "w", focused: true, tabs: [] }]),
      device("c", "Old tablet", [], { stale: true })
    ], inbox) }),
    subscribe: () => () => undefined,
    open: () => undefined,
    openSent: (id, background) => calls.push(["open", id, background]),
    dismissSent: (id) => calls.push(["dismiss", id]),
    send: async (target, sent) => calls.push(["send", target, sent.url]),
    showMenu: async (anchor, items) => { offered.push(items.map((item) => item.id)); return choices.shift() ?? null }
  }, { inbox: inboxHost })
  await settle()
  const section = inboxHost.querySelector("[data-testid=remote-inbox]")
  assert.ok(section, "the shell's own place lists the sent tabs")
  assert.equal(root.querySelector("[data-testid=remote-inbox]"), null)
  assert.match(section.textContent, /Sent page.*from Laptop/)
  section.querySelector(".remote_tab_link").dispatchEvent(click(window))
  section.querySelector(".remote_tab_dismiss").click()
  root.querySelector(".remote_tab_more").click()
  await settle()
  await settle()
  assert.deepEqual(offered, [["background", "send"], ["b"]], "only another active device can receive the phone's tab")
  assert.deepEqual(calls, [["open", "tsend_1", false], ["dismiss", "tsend_1"], ["send", "b", "https://x.example/"]])
}))

test("remote sending reports failure and a retry reports the destination", withDocument(async (document) => {
  const root = document.querySelector("#root")
  const choices = ["send", "b"]
  let attempts = 0
  mountRemoteTabs(root, {
    load: async () => ({ connected: true, view: view([
      device("a", "Phone", [{ id: "w", tabs: [tab("1", "https://example.com/", "Article")] }]),
      device("b", "Laptop", []), device("c", "Receiving off", [], { sendTarget: false })
    ]) }), subscribe: () => () => undefined, open: () => undefined,
    showMenu: async (_anchor, items) => {
      assert.equal(items.some(item => item.id === "c"), false)
      return choices.shift()
    },
    send: async () => { if (++attempts === 1) throw new Error("Offline, try again") }
  })
  await settle()
  root.querySelector(".remote_tab_more").click()
  await settle()
  const status = root.querySelector(".remote_tabs_feedback")
  assert.match(status.textContent, /Offline, try again/)
  status.querySelector("button").click()
  await settle()
  assert.equal(status.textContent, "Sent to Laptop")
  assert.equal(attempts, 2)
}))
