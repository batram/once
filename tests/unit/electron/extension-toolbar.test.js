const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const { parseHTML } = require("linkedom")

test("extensions default to the menu, persist pins, and keep pinned actions working", async () => {
  const { window, document } = parseHTML('<html><body><div id="toolbar"></div></body></html>')
  const stored = new Map()
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) }
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../../../apps/electron/src/ExtensionToolbar.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  Function("exports", "document", "window", "localStorage", compiled)(exports, document, window, storage)
  const info = { host: "example", name: "Example", title: "Open Example", enabled: true, badgeText: "2" }
  let changed
  let opened
  let menuPins = [info.host]
  let menuAction = {}
  let pinChanged
  let settingsOpened = false
  let shellFocused = false
  const bridge = { window: { focusShell: async () => { shellFocused = true } }, extensions: {
    list: async () => [info],
    onChanged: listener => { changed = listener },
    showMenu: async () => ({ pinned: menuPins, ...menuAction }),
    onPinsChanged: listener => { pinChanged = listener },
    openPopup: async host => { opened = host }
  } }
  const container = document.getElementById("toolbar")
  exports.bindExtensionToolbar(bridge, container, () => { settingsOpened = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(container.querySelectorAll(".extension-action").length, 0)
  const button = container.querySelector('[aria-label="Extensions"]')
  button.getBoundingClientRect = () => ({ x: 100, y: 0, width: 32, height: 32 })
  await button.onclick()
  assert.equal(container.querySelectorAll(".extension-action").length, 1)
  assert.deepEqual(JSON.parse(stored.get("once-electron-pinned-extensions")), [info.host])
  const action = container.querySelector(".extension-action")
  action.getBoundingClientRect = button.getBoundingClientRect
  action.onclick()
  assert.equal(opened, info.host)
  changed()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(container.querySelectorAll(".extension-action").length, 1)
  menuPins = []
  await button.onclick()
  assert.equal(container.querySelectorAll(".extension-action").length, 0)
  assert.equal(button.getAttribute("aria-expanded"), "false")
  pinChanged([info.host])
  assert.equal(container.querySelectorAll(".extension-action").length, 1)
  opened = undefined
  menuAction = { host: info.host }
  await button.onclick()
  assert.equal(opened, info.host)
  assert.equal(shellFocused, false)
  menuAction = { settings: true }
  await button.onclick()
  assert.equal(settingsOpened, true)
  assert.equal(shellFocused, true)
})
