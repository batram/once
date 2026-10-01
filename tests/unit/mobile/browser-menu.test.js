const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const { parseHTML } = require("linkedom")

test("the browser menu offers page actions without Android's extension API", async () => {
  const { document, window } = parseHTML('<html><body><button id="reading_navigate">Go</button></body></html>')
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    "../../../apps/mobile/src/browserExtensionToolbar.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  let menu
  Function("exports", "require", "document", "Event", compiled)(exports, () => ({
    showChoiceDialog: async options => { menu = options; return options.choices[0].value }
  }), document, window.Event)
  const ran = []
  exports.bindMobileExtensionToolbar(null, { showMenu: () => { throw new Error("No native extension sheet") } }, {
    list: () => [{ id: "generic.explain", label: "Explain page" }], run: id => ran.push(id)
  })
  await document.querySelector("#reading_browser_menu").onclick()
  assert.equal(menu.title, "Browser menu")
  assert.deepEqual(menu.choices.map(item => item.label), ["Explain page", "Find in page"])
  assert.equal(menu.cancelLabel, "Close")
  assert.deepEqual(ran, ["generic.explain"])
})

test("Android browser menu occupies the address action position and routes extension choices", async () => {
  const { document, window } = parseHTML('<html><body><form><div id="reading_url_group"></div><button id="reading_navigate">Go</button></form><p id="reading_url_validation" hidden></p></body></html>')
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    "../../../apps/mobile/src/browserExtensionToolbar.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  // linkedom's document only dispatches its own Event class, not Node's.
  Function("exports", "require", "document", "Event", compiled)(exports, () => ({}), document, window.Event)
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
  assert.equal(menu.dark, false, "without a theme choice or a system preference the sheet is light")
  assert.deepEqual(menu.items.map(item => item.id), ["popup", "both", "options", "once:manage"])
  assert.deepEqual(menu.items.map(item => item.settingsId), [undefined, "once:settings:both", undefined, undefined],
    "only rows whose main tap runs an action need a separate settings control")
  assert.equal(commands.length, 1, "dismissing the menu performs no extension action")
  assert.equal(button.getAttribute("aria-expanded"), "false")
  selection = "options"
  document.body.dataset.theme = "dark"
  await button.onclick()
  assert.equal(menu.dark, true, "the sheet follows the shell's explicit theme")
  delete document.body.dataset.theme
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

  // The sheet's Find control is answered by the shell's find bar, not here.
  let findRequests = 0
  document.addEventListener("once-find-in-page-request", () => { findRequests += 1 })
  const before = commands.length
  selection = "once:find"
  await button.onclick()
  assert.equal(findRequests, 1)
  assert.equal(commands.length, before + 1, "listing the extensions is the only command")
})

test("the browser sheet offers add-on page actions for the page being read and runs the chosen one", async () => {
  const { document, window } = parseHTML('<html><body><form><button id="reading_navigate">Go</button></form><p id="reading_url_validation" hidden></p></body></html>')
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    "../../../apps/mobile/src/browserExtensionToolbar.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  Function("exports", "require", "document", "Event", compiled)(exports, () => ({}), document, window.Event)
  let menu
  let selection = null
  const ran = []
  let actions = [{ id: "addon:what-wait-who-why/explain", label: "What? Wait, who, why?" }]
  exports.bindMobileExtensionToolbar(
    { command: async () => ({ extensions: [] }) },
    { showMenu: async options => { menu = options; return selection } },
    { list: () => actions, run: id => ran.push(id) }
  )
  const button = document.querySelector("#reading_browser_menu")
  await button.onclick()
  assert.deepEqual(menu.items.map(item => [item.id, item.label]), [
    ["once:manage", "Manage extensions"],
    ["once:page-action:addon:what-wait-who-why/explain", "What? Wait, who, why?"]
  ])
  selection = "once:page-action:addon:what-wait-who-why/explain"
  await button.onclick()
  assert.deepEqual(ran, ["addon:what-wait-who-why/explain"])
  // No page open, or no tray add-on: the sheet is the extensions' alone.
  actions = []
  selection = null
  await button.onclick()
  assert.deepEqual(menu.items.map(item => item.id), ["once:manage"])
})

test("iOS opens the native browser sheet with page actions and no extension rows", async () => {
  const { document, window } = parseHTML('<html><body><form><button id="reading_navigate">Go</button></form><p id="reading_url_validation" hidden></p></body></html>')
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    "../../../apps/mobile/src/browserExtensionToolbar.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  Function("exports", "require", "document", "Event", compiled)(exports, () => ({
    showChoiceDialog: async () => { throw new Error("The web dialog stands in only without a native surface") }
  }), document, window.Event)
  let menu
  let selection = "once:page-action:generic.explain"
  const ran = []
  exports.bindMobileExtensionToolbar(null,
    { available: true, showMenu: async options => { menu = options; return selection } },
    { list: () => [{ id: "generic.explain", label: "Explain page" }], run: id => ran.push(id) })
  const button = document.querySelector("#reading_browser_menu")
  await button.onclick()
  assert.equal(menu.browserControls, true)
  assert.deepEqual(menu.items.map(item => item.id), ["once:page-action:generic.explain"])
  assert.deepEqual(ran, ["generic.explain"])
  let findRequests = 0
  document.addEventListener("once-find-in-page-request", () => { findRequests += 1 })
  selection = "once:find"
  await button.onclick()
  assert.equal(findRequests, 1)
})
