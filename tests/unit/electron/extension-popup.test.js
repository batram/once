const test = require("node:test")
const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

function harness() {
  const views = []
  class View {
    constructor() {
      views.push(this)
      const contents = new EventEmitter()
      contents.destroyed = false
      contents.closes = 0
      contents.isDestroyed = () => contents.destroyed
      contents.close = () => {
        assert.equal(contents.destroyed, false)
        contents.closes++
        contents.destroyed = true
        contents.emit("destroyed")
      }
      contents.loadURL = async () => {}
      contents.focus = () => {}
      contents.setWindowOpenHandler = () => {}
      this.webContents = contents
    }
    setBackgroundColor() {}
    setBounds() {}
  }
  const filename = path.resolve(__dirname, "../../../apps/electron/src/extensions/ExtensionPopup.ts")
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  Function("exports", "require", compiled)(module.exports, name => {
    assert.equal(name, "electron")
    return { WebContentsView: View }
  })
  const popup = new module.exports.ExtensionPopup({
    popupUrl: () => "https://example.invalid/popup", webPreferences: () => ({}), register() {}
  })
  const window = new EventEmitter()
  const children = new Set()
  window.contentView = { addChildView: view => children.add(view), removeChildView: view => children.delete(view) }
  window.isDestroyed = () => false
  window.getContentBounds = () => ({ width: 800, height: 600 })
  const open = () => { popup.open(window, { x: 400, y: 0, width: 32, height: 32 }); return views.at(-1).webContents }
  return { popup, open, children }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test("popup blur waits for the native callback before closing", async () => {
  const { popup, open, children } = harness()
  const contents = open()
  contents.emit("blur")
  assert.equal(contents.closes, 0)
  assert.equal(popup.isOpen(), true)
  await settle()
  assert.equal(contents.closes, 1)
  assert.equal(popup.isOpen(), false)
  assert.equal(children.size, 0)
})

test("a popup closing itself during blur is not closed a second time", async () => {
  const { popup, open, children } = harness()
  const contents = open()
  contents.emit("blur")
  contents.close()
  await settle()
  assert.equal(contents.closes, 1)
  assert.equal(popup.isOpen(), false)
  assert.equal(children.size, 0)
})

test("a stale blur callback cannot close a replacement popup", async () => {
  const { popup, open, children } = harness()
  const first = open()
  first.emit("blur")
  const second = open()
  await settle()
  assert.equal(first.closes, 1)
  assert.equal(second.closes, 0)
  assert.equal(popup.isOpen(), true)
  assert.equal(children.size, 1)
  popup.close()
})
