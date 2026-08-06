const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

const {
  reportSettingsStatus,
  trackSettingsSave
} = require("../../../packages/ui-web/dist/settings/settingsStatus")

function block() {
  const { window } = parseHTML(`
    <div class="settings_block">
      <input id="control" value="60">
    </div>
  `)
  const previous = globalThis.document
  globalThis.document = window.document
  return {
    control: window.document.querySelector("#control"),
    status: () =>
      window.document.querySelector(".settings_block > .settings_status"),
    restore: () => {
      globalThis.document = previous
    }
  }
}

test("the status line is created once and reused by its block", () => {
  const dom = block()
  try {
    reportSettingsStatus(dom.control, "saving")
    assert.equal(dom.status().textContent, "Saving…")
    assert.equal(dom.status().dataset.state, "saving")

    reportSettingsStatus(dom.control, "saved")
    assert.equal(dom.status().textContent, "Saved")
    assert.equal(
      dom.control.closest(".settings_block")
        .querySelectorAll(".settings_status").length,
      1,
      "a second report must not add a second line"
    )
  } finally {
    dom.restore()
  }
})

test("a tracked save reports both ends, and a failure keeps failing", async () => {
  const dom = block()
  try {
    const seen = []
    await trackSettingsSave(dom.control, () => {
      seen.push(dom.status().textContent)
    })
    assert.deepEqual(seen, ["Saving…"])
    assert.equal(dom.status().textContent, "Saved")

    await assert.rejects(
      trackSettingsSave(dom.control, () => {
        throw new Error("storage is gone")
      }),
      /storage is gone/
    )
    assert.equal(dom.status().textContent, "Could not save")
    assert.equal(dom.status().dataset.state, "failed")
  } finally {
    dom.restore()
  }
})

test("a control outside a settings block reports nowhere", () => {
  const { window } = parseHTML("<input id=\"loose\">")
  const previous = globalThis.document
  globalThis.document = window.document
  try {
    reportSettingsStatus(window.document.querySelector("#loose"), "saved")
    assert.equal(window.document.querySelector(".settings_status"), null)
    reportSettingsStatus(null, "saved")
  } finally {
    globalThis.document = previous
  }
})
