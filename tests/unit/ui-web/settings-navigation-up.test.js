const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { SettingsNavigation, openSettingsPage } = require("../../../packages/ui-web/dist/settings/SettingsNavigation")

function withNavigation(run) {
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
    run({ navigation, page, shown, where: () => section, label: () => document.getElementById("settings_section_back").textContent })
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) Reflect.deleteProperty(globalThis, name)
      else globalThis[name] = previous[index]
    })
  }
}

test("a page opened in the current visit's place leaves the gestures' history pointing where the jump was made", () => {
  withNavigation(({ navigation, page, shown, where }) => {
    navigation.open("sync")
    openSettingsPage(document.getElementById("sync_root"), page("addons"), false, true)
    assert.deepEqual(shown, ["sync", "sync", "page:addons"])
    navigation.navigate("back")
    assert.equal(where(), "addons", "mouse back retraces the jump in one step")
    navigation.open("sync")
    openSettingsPage(document.getElementById("sync_root"), page("addons"))
    navigation.navigate("back")
    assert.equal(where(), "sync", "without replace, the Sync overview is a stop on the way")
  })
})

test("the button goes up the tree and says where, however the page was reached", () => {
  withNavigation(({ navigation, page, where, label, shown }) => {
    // Reached by a jump from Once Add-ons: the button still names the parent, Sync.
    navigation.open("sync")
    openSettingsPage(document.getElementById("sync_root"), page("addons"), false, true)
    assert.equal(label(), "Sync")
    navigation.up()
    assert.equal(where(), "sync")
    assert.equal(label(), "Settings")
    // Up from a section is the index; the gestures can come back down.
    navigation.up()
    assert.equal(where(), null)
    navigation.navigate("back")
    assert.equal(where(), "sync", "the section the button went up to")
    navigation.navigate("back")
    assert.equal(shown.at(-1), "page:addons", "then the page the button left")
    navigation.navigate("back")
    assert.equal(where(), "addons", "the jump's origin is still in the history")
  })
})

test("where up is also the previous visit, the button retraces it so Forward still reopens the page", () => {
  withNavigation(({ navigation, page, where, shown }) => {
    navigation.open("sync")
    openSettingsPage(document.getElementById("sync_root"), page("tabs"))
    navigation.up()
    assert.equal(where(), "sync")
    navigation.navigate("forward")
    assert.equal(shown.at(-1), "page:tabs", "forward reopens the page the button left")
  })
})

test("Up retraces a containing page and Forward restores its nested editor", () => {
  withNavigation(({ navigation, page, shown, label }) => {
    const root = document.getElementById("addons_root")
    const child = document.createElement("div")
    root.append(child)
    openSettingsPage(root, page("supplemental"))
    openSettingsPage(child, { ...page("new"), parentKey: "supplemental" })
    assert.equal(label(), "Tab sync")
    navigation.up()
    assert.equal(shown.at(-1), "page:supplemental")
    navigation.navigate("forward")
    assert.equal(shown.at(-1), "page:new")
  })
})
