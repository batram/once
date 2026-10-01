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
  Function("exports", "document", "window", "localStorage", "Event", compiled)(exports, document, window, storage, window.Event)
  const info = { host: "example", name: "Example", title: "Open Example", enabled: true, badgeText: "2" }
  let changed
  let opened
  let menuPins = [info.host, "reader"]
  let menuAction = {}
  let pinChanged
  let settingsOpened = false
  let shellFocused = false
  let menuItems
  let menuChoice = null
  let menuArgs
  let ranTool
  const bridge = { window: { focusShell: async () => { shellFocused = true } }, storyMenu: {
    show: async items => { menuItems = items; return menuChoice }
  }, extensions: {
    list: async () => [info],
    onChanged: listener => { changed = listener },
    showMenu: async (anchor, pinned, tools) => { menuArgs = { pinned, tools }; return { pinned: menuPins, ...menuAction } },
    onPinsChanged: listener => { pinChanged = listener },
    openPopup: async host => { opened = host }
  } }
  const container = document.getElementById("toolbar")
  const readerTool = { id: "reader", name: "Reader mode", icon: null, enabled: true }
  exports.bindExtensionToolbar(bridge, container, {
    openSettings: () => { settingsOpened = true },
    tools: async () => [readerTool],
    runTool: id => { ranTool = id }
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(container.querySelectorAll(".extension-action").length, 0)
  const button = container.querySelector('[aria-label="Extensions"]')
  button.getBoundingClientRect = () => ({ x: 100, y: 0, width: 32, height: 32 })
  await button.onclick()
  assert.equal(container.querySelectorAll(".extension-action").length, 1)
  assert.deepEqual(JSON.parse(stored.get("once-electron-pinned-extensions")), [info.host])
  // Shell tools start pinned and ride along in the menu's one pin list.
  assert.deepEqual(menuArgs, { pinned: ["reader"], tools: [readerTool] })
  assert.equal(exports.isToolPinned("reader"), true)
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

  // Right-clicking a pinned action offers Inspect and Unpin; only choosing
  // Unpin removes the pin.
  pinChanged([info.host])
  const pinned = container.querySelector(".extension-action")
  const contextEvent = { clientX: 5, clientY: 6, preventDefault: () => {} }
  pinned.oncontextmenu(contextEvent)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(menuItems.map(item => item.id), ["inspect", "unpin"])
  assert.equal(menuItems[1].label, "Unpin Example")
  assert.equal(container.querySelectorAll(".extension-action").length, 1)
  menuChoice = "unpin"
  pinned.oncontextmenu(contextEvent)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(container.querySelectorAll(".extension-action").length, 0)
  assert.deepEqual(JSON.parse(stored.get("once-electron-pinned-extensions")), [])

  // A tool left out of the menu's pins is hidden; choosing it runs it.
  let pinEvents = 0
  document.addEventListener("once-toolbar-pins-changed", () => pinEvents++)
  menuPins = []
  menuAction = { tool: "reader" }
  await button.onclick()
  assert.equal(ranTool, "reader")
  assert.equal(exports.isToolPinned("reader"), false)
  assert.deepEqual(JSON.parse(stored.get("once-electron-hidden-toolbar-tools")), ["reader"])
  assert.equal(pinEvents, 1)
  pinChanged(["reader"])
  assert.equal(exports.isToolPinned("reader"), true)
  exports.unpinTool("reader")
  assert.equal(exports.isToolPinned("reader"), false)
  assert.equal(pinEvents, 3)
})
