const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

test("Gecko settings reconnect after activity loss and accept settings on the new port", async () => {
  const ports = []
  const timers = []
  const registrations = []
  const context = vm.createContext({
    console,
    setTimeout: callback => timers.push(callback),
    browser: {
      runtime: { connectNative(name) {
        assert.equal(name, "once_surface")
        const port = { onMessage: { addListener(listener) { port.receive = listener } },
          onDisconnect: { addListener(listener) { port.disconnect = listener } } }
        ports.push(port)
        return port
      } },
      contentScripts: { register: async spec => {
        registrations.push(spec)
        return { unregister: async () => {} }
      } },
      webRequest: { onBeforeRequest: { addListener() {} } }
    }
  })
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,
    "../../../apps/mobile/extensions/once-surface/background.js"), "utf8"), context)
  assert.equal(ports.length, 1)
  ports[0].disconnect()
  assert.equal(timers.length, 1)
  timers.shift()()
  assert.equal(ports.length, 2)
  ports[1].receive({ type: "extension-settings", value: {
    filterLists: { lists: [] }, userscripts: { scripts: [{ id: "test", body: "document.body.dataset.works='yes'", matches: ["https://example.com/*"] }] }
  } })
  await vm.runInContext("settingsQueue", context)
  assert.equal(registrations.length, 1)
  assert.ok(registrations[0].js[0].code.includes("dataset.works"))
})
