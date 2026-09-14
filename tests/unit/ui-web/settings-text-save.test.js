const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { installRawAssetLoader } = require("../../helpers/raw-assets")
installRawAssetLoader()
const { window } = parseHTML("<html><body></body></html>")
for (const name of ["window", "document", "HTMLElement", "customElements"]) {
  globalThis[name] = name === "window" ? window : window[name]
}
const { SettingsPanel } = require("../../../packages/ui-web/dist/settings/SettingsPanel")

for (const [section, areaId, method, save] of [
  ["redirects", "redirect_area", "save_redirect_settings", "saveRedirectList"],
  ["filters", "filter_area", "save_filter_settings", "saveFilterList"]
]) {
  test(`${section} save acknowledges persistence and baseline sync before Saved`, async () => {
    const previous = global.document
    const { document } = parseHTML(`<div class="settings_block"><textarea id="${areaId}"></textarea></div>`)
    global.document = document
    try {
      const area = document.querySelector("textarea")
      area.value = section === "filters" ? "example" : "example => replacement"
      let complete
      const pending = new Promise(resolve => { complete = resolve })
      const panel = Object.create(SettingsPanel.prototype)
      panel.client = { [save]: () => pending }
      const synced = []
      panel.structuredEditors = { sync: name => {
        assert.equal(document.querySelector(".settings_status").dataset.state, "saving")
        synced.push(name)
      } }
      const saving = panel[method]()
      assert.equal(document.querySelector(".settings_status").dataset.state, "saving")
      assert.deepEqual(synced, [])
      complete()
      await saving
      assert.deepEqual(synced, [section])
      assert.equal(document.querySelector(".settings_status").dataset.state, "saved")

      panel.client[save] = async () => { throw new Error("storage unavailable") }
      await assert.rejects(panel[method](), /storage unavailable/)
      assert.equal(document.querySelector(".settings_status").dataset.state, "failed")
      assert.deepEqual(synced, [section], "Failed writes must not advance the saved baseline")
    } finally { global.document = previous }
  })
}
