const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const { parseHTML } = require("linkedom")
const { bindUserscriptSettings, userscriptSiteLabel } = require("../../../packages/ui-web/dist/settings/userscriptSettings")
const { SettingsNavigation } = require("../../../packages/ui-web/dist/settings/SettingsNavigation")

const script = (name, extra = "") => `// ==UserScript==
// @name ${name}
// @namespace once.test
// @version 1.0
// @description ${name} does things
// @match https://${name.toLowerCase()}.test/*
${extra}// ==/UserScript==
run()`

function fakeClient(scripts) {
  let doc = { version: 1, scripts }
  const saves = []
  return {
    saves,
    replace: next => { doc = next },
    getUserscripts: async () => structuredClone(doc),
    saveUserscripts: async next => { saves.push(next); doc = structuredClone(next) }
  }
}

function mountShell() {
  const { window } = parseHTML(fs.readFileSync("packages/ui-web/public/shell.html", "utf8"))
  const names = ["document", "HTMLElement", "Element", "MutationObserver", "HTMLInputElement", "HTMLTextAreaElement", "CustomEvent", "Event", "CSS", "requestAnimationFrame"]
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]))
  for (const name of names) globalThis[name] = name === "requestAnimationFrame" ? () => 0 : window[name]
  globalThis.CSS ??= { escape: value => value }
  const settings = document.querySelector("#extension_settings")
  settings.hidden = false
  const section = document.createElement("section")
  section.className = "settings_section active"
  section.dataset.settingsSection = "extensions"
  settings.parentElement.insertBefore(section, settings)
  section.append(settings)
  document.querySelector("#left_panel").setAttribute("active_panel", "settings")
  const navigation = new SettingsNavigation({
    section: () => "extensions", show: () => {}, label: () => "Userscripts",
    back: document.querySelector("#settings_section_back")
  })
  const restore = () => { for (const name of names) globalThis[name] = previous[name] }
  restore.navigation = navigation
  return restore
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test("site labels read as hosts, catch-alls as all sites", () => {
  assert.equal(userscriptSiteLabel("*://news.ycombinator.com/*"), "news.ycombinator.com")
  assert.equal(userscriptSiteLabel("https://*.example.org/path/*"), "example.org/path/*")
  assert.equal(userscriptSiteLabel("<all_urls>"), "All sites")
  assert.equal(userscriptSiteLabel("*://*/*"), "All sites")
  assert.equal(userscriptSiteLabel("/regex/"), "/regex/")
})

test("userscripts list each script, switch one alone, and edit it on its own page", async () => {
  const restore = mountShell()
  try {
    const client = fakeClient([
      { id: "a", name: "Alpha", source: script("Alpha", "// @icon data:image/png;base64,AAAA\n"), enabled: true },
      { id: "b", name: "Beta", source: script("Beta", "// @grant GM_xmlhttpRequest\n"), enabled: false }
    ])
    const root = document.querySelector("#userscripts_settings")
    const view = bindUserscriptSettings(client, root, document.querySelector("#userscripts_bulk"), () => {})
    await settle()
    const rows = () => [...root.querySelectorAll(".userscript_row")]
    assert.deepEqual(rows().map(row => row.querySelector("strong").textContent), ["Alpha", "Beta"])
    assert.equal(rows()[0].querySelector(".userscript_icon img").getAttribute("src"), "data:image/png;base64,AAAA")
    assert.equal(rows()[1].querySelector(".userscript_icon img"), null)
    assert.match(rows()[1].querySelector(".userscript_row_meta").textContent, /beta\.test · Off/)
    assert.equal(rows()[1].querySelector(".switch").checked, false)

    // The switch saves that script alone, against the latest document.
    client.replace({ version: 1, scripts: [
      { id: "a", name: "Alpha", source: script("Alpha"), enabled: true },
      { id: "b", name: "Beta", source: script("Beta"), enabled: false },
      { id: "c", name: "Gamma", source: script("Gamma"), enabled: true }
    ] })
    const toggle = rows()[1].querySelector(".switch")
    toggle.checked = true
    toggle.dispatchEvent(new Event("change"))
    await settle(); await settle()
    assert.deepEqual(client.saves.at(-1).scripts.map(item => [item.name, item.enabled]),
      [["Alpha", true], ["Beta", true], ["Gamma", true]])
    assert.equal(rows().length, 3)

    // A script's page reads its header and edits its source alone.
    rows()[0].querySelector(".userscript_row_main").click()
    assert.equal(root.dataset.page, "script")
    assert.equal(document.querySelector(".settings_title").textContent, "Alpha")
    const source = root.querySelector('[data-testid="userscript-source"]')
    assert.equal(root.querySelector('[data-testid="save-userscript"]').disabled, true)
    assert.match(root.querySelector(".userscript_facts").textContent, /alpha\.test/)
    source.value = source.value.replace("run()", "runFaster()")
    source.dispatchEvent(new Event("input"))
    root.querySelector('[data-testid="save-userscript"]').click()
    await settle(); await settle()
    assert.match(client.saves.at(-1).scripts[0].source, /runFaster/)
    assert.equal(client.saves.at(-1).scripts.length, 3)

    // An edit elsewhere under an unsaved draft is flagged, not overwritten.
    const draft = root.querySelector('[data-testid="userscript-source"]')
    assert.equal(draft.value.includes("runFaster"), true)
    draft.value = `${draft.value}\n// mine`
    draft.dispatchEvent(new Event("input"))
    const latest = await client.getUserscripts()
    latest.scripts[0].source = latest.scripts[0].source.replace("runFaster", "theirs")
    client.replace(latest)
    view.refresh()
    await settle(); await settle()
    // Compared as a boolean: a failing comparison of DOM nodes walks the whole document.
    assert.equal(root.querySelector('[data-testid="userscript-source"]') === draft, true)
    assert.match(draft.value, /\/\/ mine/)
    assert.equal(root.querySelector(".userscript_notice").hidden, false)
    root.querySelector('[data-testid="revert-userscript"]').click()

    // Back leaves the page for the list.
    document.querySelector("#settings_section_back").click()
    assert.equal(root.dataset.page, "list")
  } finally {
    restore()
  }
})

test("a new userscript starts from a template and adds to the end", async () => {
  const restore = mountShell()
  try {
    const client = fakeClient([])
    const root = document.querySelector("#userscripts_settings")
    bindUserscriptSettings(client, root, document.querySelector("#userscripts_bulk"), () => {})
    await settle()
    assert.equal(root.querySelector(".userscripts_empty").hidden, false)
    root.querySelector('[data-testid="add-userscript"]').click()
    assert.equal(root.dataset.page, "new")
    root.querySelector('[data-testid="save-userscript"]').click()
    await settle(); await settle()
    assert.deepEqual(client.saves.at(-1).scripts.map(item => item.name), ["New script"])
    assert.equal(root.dataset.page, "script")
    assert.equal(root.querySelector(".userscript_detail h3").textContent, "New script")
  } finally {
    restore()
  }
})

test("Back and Forward retain an unsaved userscript without saving or prompting", async () => {
  const restore = mountShell()
  try {
    const client = fakeClient([{ id: "a", name: "Alpha", source: script("Alpha"), enabled: true }])
    const root = document.querySelector("#userscripts_settings")
    bindUserscriptSettings(client, root, document.querySelector("#userscripts_bulk"), () => {})
    await settle()
    root.querySelector(".userscript_row_main").click()
    const textarea = root.querySelector('[data-testid="userscript-source"]')
    textarea.value += "\n// unfinished"
    for (let cycle = 0; cycle < 3; cycle++) {
      restore.navigation.navigate("back")
      assert.equal(root.dataset.page, "list")
      restore.navigation.navigate("forward")
      assert.equal(root.dataset.page, "script")
      assert.equal(root.querySelector('[data-testid="userscript-source"]') === textarea, true)
      assert.match(textarea.value, /unfinished/)
    }
    assert.equal(client.saves.length, 0)
    assert.equal(document.querySelector("dialog"), null)
  } finally { restore() }
})

test("deleting a userscript elsewhere keeps its unsaved draft available for review", async () => {
  const restore = mountShell()
  try {
    const client = fakeClient([{ id: "a", name: "Alpha", source: script("Alpha"), enabled: true }])
    const root = document.querySelector("#userscripts_settings")
    const view = bindUserscriptSettings(client, root, document.querySelector("#userscripts_bulk"), () => {})
    await settle()
    root.querySelector(".userscript_row_main").click()
    const textarea = root.querySelector('[data-testid="userscript-source"]')
    textarea.value += "\n// unfinished"
    client.replace({ version: 1, scripts: [] })
    view.refresh()
    await settle()
    assert.equal(root.dataset.page, "script")
    assert.equal(root.querySelector(".userscript_notice").hidden, false)
    restore.navigation.navigate("back")
    restore.navigation.navigate("forward")
    assert.equal(root.querySelector('[data-testid="userscript-source"]') === textarea, true)
    assert.match(textarea.value, /unfinished/)
  } finally { restore() }
})
