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

test("requests a URL instead of injecting into missing or non-HTTP tabs", async () => {
  const missing = fakeBrowser(null)
  installPickerBackground(missing.api)
  assert.deepEqual(
    await missing.api.runtime.onMessage.listeners[0]({
      onceCommand: "startSourcePicker"
    }),
    { needsUrl: true }
  )

  const privileged = fakeBrowser({ id: 3, url: "about:config" })
  installPickerBackground(privileged.api)
  assert.deepEqual(
    await privileged.api.runtime.onMessage.listeners[0]({
      onceCommand: "startSourcePicker"
    }),
    { needsUrl: true }
  )
  assert.deepEqual(privileged.executed, [])
})
