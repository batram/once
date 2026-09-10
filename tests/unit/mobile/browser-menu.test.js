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
  exports.bindMobileExtensionToolbar({ command: async command => {
    commands.push(command)
    return { extensions: [
      { id: "popup", name: "Popup", enabled: true, hasAction: true },
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
  assert.deepEqual(menu.items.map(item => item.id), ["popup", "options", "once:manage"])
  assert.equal(commands.length, 1, "dismissing the menu performs no extension action")
  assert.equal(button.getAttribute("aria-expanded"), "false")
  selection = "options"
  await button.onclick()
  assert.deepEqual(commands.at(-1), { action: "options", id: "options" })
  selection = "popup"
  await button.onclick()
  assert.deepEqual(commands.at(-1), { action: "action", id: "popup" })
})
