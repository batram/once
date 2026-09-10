const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const { parseHTML } = require("linkedom")

const settle = () => new Promise(resolve => setImmediate(resolve))

function harness(command) {
  const { window, document } = parseHTML(`<html><body><div id="settings_panel">
    <button id="settings_section_back">Settings</button><h2 class="settings_title"></h2>
    <div class="settings_section active"><div id="extension_settings"><p id="supplemental">Filters</p></div></div>
    </div></body></html>`)
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    "../../../apps/mobile/src/browserExtensionSettings.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  Function("exports", "document", "MutationObserver", compiled)(exports, document, window.MutationObserver)
  exports.bindMobileBrowserExtensionSettings({ command, onChanged: async () => () => {} })
  const click = text => {
    const button = [...document.querySelectorAll("button")].find(button => button.textContent === text || button.getAttribute("aria-label") === text)
    assert.ok(button, `button ${text} exists`)
    button.click()
    return settle()
  }
  return { document, click }
}

test("Android extension management preserves disabled entries and confirms removal", async () => {
  let items = [{ id: "dark", name: "Dark", description: "Changes page colors", version: "1", enabled: false,
    bundled: false, hasOptions: true, hasAction: true, permissions: ["<all_urls>"] }]
  const calls = []
  const ui = harness(async command => {
    calls.push(command)
    if (command.action === "enable") items[0].enabled = command.enabled
    if (command.action === "remove") items = []
    return { extensions: items }
  })
  await settle()
  await ui.click("Manage Dark")
  assert.equal([...ui.document.querySelectorAll("button")].find(button => button.textContent === "Open extension settings").disabled, true)
  await ui.click("Enable extension")
  assert.ok(calls.some(call => call.action === "enable" && call.enabled))
  await ui.click("Remove extension…")
  assert.equal(calls.some(call => call.action === "remove"), false)
  await ui.click("Keep extension")
  await ui.click("Remove extension…")
  await ui.click("Remove extension and data")
  assert.equal(calls.filter(call => call.action === "remove").length, 1)
  assert.equal(ui.document.querySelector('[aria-label="Manage Dark"]'), null)
})

test("Android install errors remain visible and file cancellation preserves the install page", async () => {
  const ui = harness(async command => {
    if (command.action === "install") throw new Error("Signature could not be verified")
    if (command.action === "chooseFile") return { cancelled: true }
    return { extensions: [] }
  })
  await settle()
  await ui.click("Install extension")
  await ui.click("Review Dark Reader")
  assert.match(ui.document.querySelector('[role="status"]').textContent, /Signature could not be verified/)
  await ui.click("Choose signed XPI file…")
  assert.ok(ui.document.querySelector("#mobile-extension-source"))
  await ui.click("Browser Extensions")
  await ui.click("Filter lists & userscripts")
  assert.equal(ui.document.querySelector("#supplemental").parentElement.hidden, false)
})
