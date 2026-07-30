const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

test("update controls expose status and disable busy checks", async () => {
  const { window } = parseHTML(`
    <input
      type="button"
      data-testid="check-for-updates"
      value="Check for updates"
      hidden
    />
    <span data-testid="update-status"></span>
  `)
  const previousDocument = globalThis.document
  globalThis.document = window.document

  try {
    const { bindAppUpdateControls } = require(
      "../../../packages/ui-web/dist/settings/appUpdateControls"
    )
    let statusHandler = () => {}
    let checks = 0
    bindAppUpdateControls({
      getStatus: async () => ({ state: "idle" }),
      checkForUpdates: async () => {
        checks += 1
        return { state: "current" }
      },
      onStatusChanged(handler) {
        statusHandler = handler
        return () => {}
      }
    })

    await new Promise(setImmediate)
    const button = document.querySelector("[data-testid='check-for-updates']")
    const status = document.querySelector("[data-testid='update-status']")
    assert.equal(button.hidden, false)
    assert.equal(button.disabled, false)

    button.click()
    assert.equal(button.disabled, true)
    assert.equal(button.value, "Checking…")
    await new Promise(setImmediate)
    assert.equal(checks, 1)
    assert.equal(button.disabled, false)
    assert.equal(status.textContent, "Up to date")

    statusHandler({ state: "available" })
    assert.equal(checks, 1)
    assert.equal(button.disabled, true)
    assert.equal(button.value, "Downloading…")
  } finally {
    if (previousDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document")
    } else {
      globalThis.document = previousDocument
    }
  }
})
