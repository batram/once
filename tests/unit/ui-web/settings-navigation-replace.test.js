const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { SettingsNavigation, openSettingsPage } = require("../../../packages/ui-web/dist/settings/SettingsNavigation")

test("a page opened in the current visit's place leaves Back pointing where the jump was made", () => {
  const { window } = parseHTML('<html><body><main id="left_panel" active_panel="settings"><div id="settings_panel"><button id="settings_section_back"></button><section class="settings_section" data-settings-section="addons"><div id="addons_root"></div></section><section class="settings_section" data-settings-section="sync"><div id="sync_root"></div></section></div></main></body></html>')
  const names = ["window", "document", "CustomEvent", "HTMLElement", "Element", "requestAnimationFrame"]
  const previous = names.map(name => globalThis[name])
  for (const name of names) globalThis[name] = name === "requestAnimationFrame" ? () => 0 : window[name]
  try {
    let section = "addons"
    const shown = []
    const navigation = new SettingsNavigation({
      section: () => section,
      show: next => { section = next; shown.push(next) },
      label: key => key === null ? "Settings" : key === "addons" ? "Once Add-ons" : "Sync",
      back: document.getElementById("settings_section_back")
    })
    const page = key => ({ key, title: () => key === "addons" ? "Add-on sync" : "Tab sync", show: () => shown.push(`page:${key}`) })
    // The jump: switch to Sync, then open its Add-on sync page in that visit's place.
    navigation.open("sync")
    openSettingsPage(document.getElementById("sync_root"), page("addons"), false, true)
    assert.deepEqual(shown, ["sync", "sync", "page:addons"])
    assert.equal(document.getElementById("settings_section_back").textContent, "Once Add-ons")
    navigation.navigate("back")
    assert.equal(section, "addons")
    // Without replace, the same jump leaves the Sync overview as a stop on the way back.
    navigation.open("sync")
    openSettingsPage(document.getElementById("sync_root"), page("addons"))
    assert.equal(document.getElementById("settings_section_back").textContent, "Sync")
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) Reflect.deleteProperty(globalThis, name)
      else globalThis[name] = previous[index]
    })
  }
})
