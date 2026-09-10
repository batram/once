const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const { parseHTML } = require("linkedom")

test("Android browser menu occupies the address action position and routes extension choices", async () => {
  const { document } = parseHTML('<html><body><form><div id="reading_url_group"></div><button id="reading_navigate">Go</button></form><p id="reading_url_validation" hidden></p></body></html>')
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    "../../../apps/mobile/src/browserExtensionToolbar.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  Function("exports", "document", compiled)(exports, document)
  const commands = []
  let menu
  let selection = null
  let noPage = false
  let manager = 0
  const settingsButton = document.createElement("button")
  settingsButton.id = "settings_menu_btn"
  settingsButton.onclick = () => { manager += 1 }
  document.body.append(settingsButton)
  exports.bindMobileExtensionToolbar({ command: async command => {
    commands.push(command)
    if (command.action === "action") return { noPage }
    return { extensions: [
      { id: "popup", name: "Popup", enabled: true, hasAction: true },
      { id: "both", name: "Both", enabled: true, hasAction: true, hasOptions: true },
      { id: "options", name: "Options", enabled: true, hasOptions: true },
      { id: "disabled", name: "Disabled", enabled: false, hasAction: true }
    ] }
  } }, { showMenu: async options => { menu = options; return selection } })
  const button = document.querySelector("#reading_browser_menu")
  assert.equal(document.querySelector("#reading_navigate").nextElementSibling, button)
  assert.equal(document.querySelector("#reading_url_group").children.length, 0)
  assert.equal(button.type, "button")
  await button.onclick()
  assert.equal(menu.browserControls, true)
  assert.deepEqual(menu.items.map(item => item.id), ["popup", "both", "options", "once:manage"])
  assert.deepEqual(menu.items.map(item => item.settingsId), [undefined, "once:settings:both", undefined, undefined],
    "only rows whose main tap runs an action need a separate settings control")
  assert.equal(commands.length, 1, "dismissing the menu performs no extension action")
  assert.equal(button.getAttribute("aria-expanded"), "false")
  selection = "options"
  await button.onclick()
  assert.deepEqual(commands.at(-1), { action: "options", id: "options" })
  selection = "popup"
  await button.onclick()
  assert.deepEqual(commands.at(-1), { action: "action", id: "popup" })
  assert.equal(manager, 0)
  selection = "once:settings:both"
  await button.onclick()
  assert.deepEqual(commands.at(-1), { action: "options", id: "both" })
  noPage = true
  selection = "popup"
  const validation = document.querySelector("#reading_url_validation")
  validation.textContent = "stale"
  validation.hidden = false
  await button.onclick()
  assert.deepEqual(commands.at(-1), { action: "action", id: "popup" })
  assert.equal(manager, 1, "an action without a page or an options page opens the manager")
  assert.equal(validation.hidden, true, "opening the menu clears an earlier error")
})
