const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { bindSyncCompatibilityControls } = require("../../../packages/ui-web/dist/settings/syncCompatibilityControls")

test("only a proven protocol mismatch offers an update; retrying and new connections hide the warning", () => {
  const previous = globalThis.document
  globalThis.document = parseHTML('<div id="sync_settings"></div>').document
  try {
    const show = bindSyncCompatibilityControls({ recheckSyncCompatibility() {} })
    const panel = document.querySelector('[data-testid="sync-compatibility"]')
    const update = [...panel.querySelectorAll("button")].find(value => value.textContent === "Update Once")
    show({ state: "update-required", message: "Unknown version" })
    assert.equal(panel.hidden, true)
    show({ state: "update-required", message: "Update required", compatibility: { supportedSyncProtocol: 1, requiredSyncProtocol: 2 } })
    assert.equal(panel.hidden, false)
    assert.equal(update.hidden, false)
    show({ state: "connecting", message: "Connecting" })
    assert.equal(panel.hidden, true)
    show({ state: "retrying", message: "Connection interrupted. Sync will retry automatically." })
    assert.equal(panel.hidden, true)
    show({ state: "error", message: "Sync paused. The database sync metadata needs attention. Your local data is retained." })
    assert.equal(panel.hidden, false)
    assert.equal(update.hidden, true)
    assert.equal(panel.querySelector("h3").textContent, "Sync needs attention")
  } finally { globalThis.document = previous }
})
