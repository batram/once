const test = require("node:test")
const assert = require("node:assert/strict")
const { installPickerBackground } = require("../../../packages/webext-shell/dist/pickerBackground")

function event() {
  const listeners = []
  return {
    listeners,
    addListener(listener) { listeners.push(listener) },
    removeListener(listener) {
      const index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    }
  }
}

function fakeBrowser(tab) {
  const executed = []
  return {
    executed,
    api: {
      runtime: { onMessage: event() },
      tabs: { async query() { return tab ? [tab] : [] } },
      scripting: { async executeScript(options) { executed.push(options) } }
    }
  }
}

test("injects the picker content script into the active HTTP tab", async () => {
  const { api, executed } = fakeBrowser({ id: 7, url: "https://example.com/list" })
  const uninstall = installPickerBackground(api)
  const [listener] = api.runtime.onMessage.listeners

  assert.equal(listener({ onceCommand: "openReader" }), undefined)
  await listener({ onceCommand: "startSourcePicker" })
  assert.deepEqual(executed, [
    { target: { tabId: 7 }, files: ["/picker-content.js"] }
  ])

  uninstall()
  assert.equal(api.runtime.onMessage.listeners.length, 0)
})

test("refuses to inject into missing or non-HTTP tabs", async () => {
  const missing = fakeBrowser(null)
  installPickerBackground(missing.api)
  await assert.rejects(
    missing.api.runtime.onMessage.listeners[0]({ onceCommand: "startSourcePicker" }),
    /no active tab/
  )

  const privileged = fakeBrowser({ id: 3, url: "about:config" })
  installPickerBackground(privileged.api)
  await assert.rejects(
    privileged.api.runtime.onMessage.listeners[0]({ onceCommand: "startSourcePicker" }),
    /HTTP or HTTPS/
  )
  assert.deepEqual(privileged.executed, [])
})
