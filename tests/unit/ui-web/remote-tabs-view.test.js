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

function view(devices) {
  return { available: true, canShare: false, self: null, options: {}, shared: {}, devices, notice: null }
}

test("lists devices and windows, filters, opens in front or behind, and keeps folding across updates", async () => {
  const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>")
  const previous = { document: global.document }
  global.document = document
  try {
    const listeners = new Set()
    let state = { connected: true, view: view([
      device("a", "Phone", [{ id: "w", focused: true, tabs: [tab("1", "https://news.example/a", "Alpha", "reader"), tab("2", "https://www.video.example/b", "Beta")] }]),
      device("b", "Laptop", [
        { id: "w1", focused: true, tabs: [tab("3", "https://docs.example/c", "Gamma")] },
        { id: "w2", focused: false, tabs: [tab("4", "https://docs.example/d", "Delta")] }
      ])
    ]) }
    const opened = []
    const root = document.querySelector("#root")
    const handle = mountRemoteTabs(root, {
      load: async () => state,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
      open: (item, background) => opened.push([item.url, background])
    })
    await settle()
    const devices = () => [...root.querySelectorAll("[data-testid=remote-device]")]
    assert.deepEqual(devices().map((section) => section.querySelector(".remote_device_name").textContent), ["Phone", "Laptop"])
    assert.match(devices()[0].textContent, /news\.example · Reader/)
    assert.equal(devices()[1].querySelectorAll(".remote_window_heading").length, 2, "two windows are labelled")

    const links = () => [...root.querySelectorAll(".remote_tab_link")]
    // linkedom has no MouseEvent; the view reads only the modifier keys.
    const click = (modifiers = {}) => Object.assign(new window.Event("click", { bubbles: true, cancelable: true }), modifiers)
    links()[0].dispatchEvent(click())
    links()[1].dispatchEvent(click({ ctrlKey: true }))
    root.querySelector(".remote_tab_background").click()
    assert.deepEqual(opened, [["https://news.example/a", false], ["https://www.video.example/b", true], ["https://news.example/a", true]])

    devices()[0].querySelector(".remote_device_header").click()
    assert.equal(devices()[0].querySelectorAll(".remote_tab").length, 0, "a folded device hides its tabs")
    state = { ...state, view: view([...state.view.devices, device("c", "Tablet", [], { sharing: false })]) }
    listeners.forEach((listener) => listener())
    await settle()
    assert.equal(devices()[0].querySelectorAll(".remote_tab").length, 0, "folding survives new data")
    assert.match(devices()[2].textContent, /Not sharing its tabs/)

    const filter = root.querySelector("[data-testid=remote-tabs-filter]")
    filter.value = "delta"
    filter.dispatchEvent(new window.Event("input"))
    assert.deepEqual(devices().map((section) => section.querySelector(".remote_device_name").textContent), ["Laptop"])
    assert.deepEqual(links().map((link) => link.getAttribute("href")), ["https://docs.example/d"])
    handle.dispose()
  } finally {
    global.document = previous.document
  }
})

test("explains what is missing instead of showing an empty list", async () => {
  const { document } = parseHTML("<html><body><div id='root'></div></body></html>")
  const previous = global.document
  global.document = document
  try {
    let opened = 0
    const root = document.querySelector("#root")
    mountRemoteTabs(root, { load: async () => ({ connected: false, view: view([]) }), subscribe: () => () => undefined,
      open: () => undefined, openSettings: () => { opened++ } })
    await settle()
    assert.match(root.textContent, /Connect sync to see tabs from your other devices/)
    root.querySelector(".remote_tabs_notice button").click()
    assert.equal(opened, 1)
  } finally {
    global.document = previous
  }
})
