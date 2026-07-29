const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

const {
  updateSettingsSummaries
} = require("../../../packages/ui-web/dist/settings/SettingsSummaries")

test("settings summaries report counts, state, and source failures", () => {
  const { window } = parseHTML(`
    <textarea id="sources_area"></textarea>
    <textarea id="filter_area"></textarea>
    <textarea id="redirect_area"></textarea>
    <select id="theme_select"><option value="dark" selected>Dark</option></select>
    <input id="anim_checkbox" type="checkbox" checked>
    <input id="cache_time_input" value="45">
    <span id="couch_status">Connected</span>
    <span data-testid="app-version">Once 0.2.0</span>
  `)
  const previousDocument = globalThis.document
  globalThis.document = window.document
  try {
    window.document.querySelector("#sources_area").value =
      "https://one.test\n*group\nhttps://two.test"
    window.document.querySelector("#filter_area").value = "one\n\n two"
    window.document.querySelector("#redirect_area").value = "one => two"
    window.document.querySelector("#anim_checkbox").checked = true
    const buttons = new Map()
    for (const key of [
      "sources",
      "filters",
      "redirects",
      "sync",
      "theme",
      "swipe",
      "cache",
      "errors",
      "about"
    ]) {
      const button = window.document.createElement("button")
      const summary = window.document.createElement("span")
      summary.className = "settings_section_summary"
      button.append(summary)
      buttons.set(key, button)
    }
    buttons.get("errors").dataset.errorCount = "1"
    buttons.get("errors").dataset.warningCount = "2"

    updateSettingsSummaries(buttons, 1)

    assert.equal(
      buttons.get("sources").textContent,
      "2 · 1 failing"
    )
    assert.equal(buttons.get("filters").textContent, "2 keywords")
    assert.equal(buttons.get("redirects").textContent, "1 rule")
    assert.equal(buttons.get("sync").textContent, "Connected")
    assert.equal(buttons.get("theme").textContent, "Dark · animated")
    assert.equal(buttons.get("cache").textContent, "45 min")
    assert.equal(buttons.get("errors").textContent, "1 error · 2 warnings")
    assert.ok(
      buttons.get("sources").firstElementChild.classList.contains(
        "settings_section_summary_error"
      )
    )
  } finally {
    if (previousDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document")
    } else {
      globalThis.document = previousDocument
    }
  }
})
