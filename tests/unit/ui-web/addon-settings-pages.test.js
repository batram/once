const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const { parseHTML } = require("linkedom")
const { bindAddonSettingsPages } = require("../../../packages/ui-web/dist/settings/AddonSettingsPages")
const { settingsSearchSegments } = require("../../../packages/ui-web/dist/settings/settingsSearch")
const { SettingsNavigation } = require("../../../packages/ui-web/dist/settings/SettingsNavigation")

test("addon pages isolate settings, preserve drafts, reveal advanced JSON and recover after removal", async () => {
  const { window } = parseHTML(fs.readFileSync("packages/ui-web/public/shell.html", "utf8"))
  const names = ["document", "HTMLElement", "Element", "MutationObserver", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "CustomEvent", "Event", "requestAnimationFrame"]
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]))
  for (const name of names) globalThis[name] = name === "requestAnimationFrame" ? () => 0 : window[name]
  const settle = () => new Promise(resolve => setImmediate(resolve))
  try {
    const root = document.querySelector("#addon_install_settings")
    const section = document.createElement("section")
    section.className = "settings_section active"
    section.dataset.settingsSection = "addons"
    root.parentElement.insertBefore(section, root)
    section.append(root)
    document.querySelector("#left_panel").setAttribute("active_panel", "settings")
    const navigation = new SettingsNavigation({
      section: () => "addons", show: () => {}, label: () => "Once Add-ons",
      back: document.querySelector("#settings_section_back")
    })
    const imports = document.createElement("div")
    imports.innerHTML = '<div class="settings_actions"><button data-testid="import-addon-zip">ZIP</button></div><p>Package help</p><p role="status"></p><div id="addon_installed"></div><div id="addon_previews"></div>'
    root.prepend(...imports.children)
    const options = document.querySelector("#addon_options")
    options.innerHTML = '<fieldset class="addon_options_group" data-addon="first" data-addon-name="First" data-enabled="true"><legend>First</legend><div class="field"><label for="draft">Prompt</label><textarea id="draft">Default</textarea></div><p class="addon_runtime_status">Enabled</p></fieldset><fieldset class="addon_options_group" data-addon="second" data-addon-name="Second" data-enabled="false"><legend>Second</legend><input id="token" type="password"></fieldset>'
    bindAddonSettingsPages(root)
    const button = id => root.querySelector(`[data-testid="${id}"]`)
    const back = document.querySelector("#settings_section_back")
    const first = root.querySelector('.addon_list_row[data-addon-id="first"]')
    const draft = root.querySelector("#draft")
    assert.equal(root.querySelector("#addon_overview").hidden, false)
    assert.equal(root.querySelector("#addon_advanced").hidden, true)
    assert.equal(options.closest(".addon_page").hidden, true)
    assert.equal(root.querySelectorAll(".addon_list_row").length, 2)
    first.click()
    assert.equal(document.querySelector(".settings_title").textContent, "First")
    assert.equal(options.children[0].hidden, false)
    assert.equal(options.children[1].hidden, true)
    draft.value = "Unfinished draft"
    options.querySelector(".addon_runtime_status").textContent = "Ready"
    await settle()
    assert.equal(root.querySelector('.addon_list_row[data-addon-id="first"]'), first)
    back.click()
    assert.equal(root.querySelector("#addon_overview").hidden, false)
    // The mouse's back button asks the same question: an add-on's page steps to the overview,
    // and only the overview lets the step leave the section.
    first.click()
    navigation.navigate("back")
    assert.equal(root.querySelector("#addon_overview").hidden, false)
    navigation.navigate("forward")
    assert.equal(options.children[0].hidden, false)
    navigation.navigate("back")
    // A review shows where it was asked for: an update's on the overview, an import's on its page.
    first.click()
    const review = document.createElement("fieldset")
    root.querySelector("#addon_updates").append(review)
    review.dispatchEvent(new window.Event("once:addon-review", { bubbles: true }))
    assert.equal(root.querySelector("#addon_overview").hidden, false)
    review.remove()
    root.querySelector("#addon_previews").append(review)
    review.dispatchEvent(new window.Event("once:addon-review", { bubbles: true }))
    assert.equal(root.querySelector("#addon_import").hidden, false)
    review.remove()
    back.click()
    first.click()
    assert.equal(root.querySelector("#draft"), draft)
    assert.equal(draft.value, "Unfinished draft")
    options.children[0].remove()
    await settle()
    assert.equal(root.querySelector("#addon_overview").hidden, false)
    assert.equal(root.querySelectorAll(".addon_list_row").length, 1)
    button("open-addon-advanced").click()
    assert.equal(root.querySelector("#addon_advanced").hidden, false)
    root.querySelector('#addon_advanced button[data-action="cancel"]').click()
    assert.equal(root.querySelector("#addon_advanced").hidden, true)
    assert.equal(root.querySelector("#addon_overview").hidden, false)
    assert.equal(document.querySelector(".settings_title").textContent, "Once Add-ons")
    navigation.navigate("forward")
    assert.equal(root.querySelector("#addon_advanced").hidden, true)
    button("open-addon-import").click()
    assert.equal(root.querySelector("#addon_import").hidden, false)
    assert.equal(root.querySelector("#addon_advanced").hidden, true)
    assert.equal(root.querySelector('[data-testid="import-addon-zip"]').closest(".addon_import_method").hidden, false)
    root.dispatchEvent(new window.CustomEvent("once:addon-reveal", { detail: root.querySelector("#addons_area") }))
    assert.equal(root.querySelector("#addon_advanced").hidden, false)
    root.querySelector("#token").value = "secret-draft-do-not-index"
    assert.equal(settingsSearchSegments(section).some(segment => segment.text.includes("secret-draft")), false)
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) Reflect.deleteProperty(globalThis, name)
      else globalThis[name] = previous[name]
    }
  }
})
