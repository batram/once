const test = require("node:test")
const assert = require("node:assert/strict")
const { initChromeBackground } = require("../../../packages/webext-shell/dist/chromeBackground")
const { initFirefoxBackground } = require("../../../packages/webext-shell/dist/firefoxBackground")

function event() {
  const listeners = []
  return {
    listeners,
    addListener(listener) { listeners.push(listener) },
    removeListener(listener) {
      const index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    },
    emit(...args) { return listeners.map((listener) => listener(...args)) }
  }
}

test("configures Chrome action clicks to open the side panel", async () => {
  const calls = []
  initChromeBackground({ sidePanel: { async setPanelBehavior(options) { calls.push(options) } } })
  await Promise.resolve()
  assert.deepEqual(calls, [{ openPanelOnActionClick: true }])

  const errors = []
  initChromeBackground(undefined, (message) => errors.push(message))
  assert.deepEqual(errors, ["Once requires the Chrome Side Panel API"])
})

test("sets up Firefox sidebar action, context menu, and undo command", async () => {
  const actionClicked = event()
  const menuClicked = event()
  const calls = []
  const api = {
    action: { onClicked: actionClicked },
    sidebarAction: { toggle() { calls.push("toggle") } },
    contextMenus: {
      async removeAll() { calls.push("removeAll") },
      create(options) { calls.push(options) },
      onClicked: menuClicked
    },
    runtime: {
      getURL: (value) => `moz-extension://test${value}`,
      async sendMessage(message) { calls.push(message) }
    }
  }
  await initFirefoxBackground(api)
  actionClicked.emit()
  menuClicked.emit({ menuItemId: "other" })
  menuClicked.emit({ menuItemId: "once_undo" })
  await Promise.resolve()

  assert.equal(calls[0], "removeAll")
  assert.equal(calls[1].documentUrlPatterns[0], "moz-extension://test/static/sidepanel.html")
  assert.ok(calls.includes("toggle"))
  assert.deepEqual(calls.at(-1), { onceCommand: "history", action: "undo" })
})

module.exports = { event }
