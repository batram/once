const test = require("node:test")
const assert = require("node:assert/strict")
const { addonOrigin, addonRuntimeLabel, folderName } = require("../../../packages/ui-web/dist/settings/addonPresentation")

test("an add-on's row says where it comes from, not what it is not", () => {
  const manifest = { id: "example", name: "Example", version: "1.0.0" }
  assert.equal(addonOrigin({ enabled: true, manifest: { ...manifest, script: { url: "once-addon://bundled/example/main.js", integrity: "x" } } }), "Bundled with Once")
  assert.equal(addonOrigin({ enabled: true, manifest, source: { url: "https://addons.example.org/x/once-addon.json" } }), "From addons.example.org")
  assert.equal(addonOrigin({ enabled: true, manifest: { ...manifest, script: { url: "once-addon://local/example/main.js", integrity: "x" } } }), "Imported copy")
  assert.equal(folderName("C:\\Users\\me\\addons\\what-wait-who-why\\"), "what-wait-who-why")
  assert.equal(folderName("/home/me/addons/example"), "example")
})

test("runtime states read as the reader would say them, and Retry only follows a failure", () => {
  assert.deepEqual(addonRuntimeLabel({ state: "idle" }, true), { text: "Ready", tone: "ok", retry: false })
  assert.deepEqual(addonRuntimeLabel({ state: "running" }, true), { text: "Running", tone: "ok", retry: false })
  assert.deepEqual(addonRuntimeLabel(undefined, true), { text: "Starting…", tone: "busy", retry: false })
  assert.deepEqual(addonRuntimeLabel({ state: "failed", error: "boom" }, true), { text: "Failed: boom", tone: "error", retry: true })
  assert.deepEqual(addonRuntimeLabel({ state: "unavailable", error: "offline" }, true), { text: "Unavailable: offline", tone: "error", retry: true })
  assert.deepEqual(addonRuntimeLabel({ state: "failed" }, false), { text: "Disabled", tone: "off", retry: false })
})
