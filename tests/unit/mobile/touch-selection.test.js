const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

// Stands in for Element; `text` says whether the tap landed on comment text.
function FakeElement(text) { this.text = text }

function load(platform = "android") {
  const source = fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/src/touchSelection.ts"), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const presses = []
  const selection = { calls: [], collapse(node, offset) { this.calls.push(["collapse", node, offset]) }, modify(...args) { this.calls.push(["modify", ...args]) } }
  const document = { caretPositionFromPoint: (x, y) => ({ offsetNode: `text@${x},${y}`, offset: 2 }) }
  const moduleObject = { exports: {} }
  Function("exports", "require", "window", "document", "Element", compiled)(moduleObject.exports, name => {
    if (name === "@capacitor/core") {
      return {
        Capacitor: { getPlatform: () => platform },
        registerPlugin: () => ({ longPressAt: async options => { presses.push(options) } })
      }
    }
    return {}
  }, { devicePixelRatio: 3, getSelection: () => selection }, document, FakeElement)
  const listeners = {}
  const root = { addEventListener: (type, listener) => { listeners[type] = listener } }
  moduleObject.exports.selectOnDoubleTap(root, target => target.text)
  const tap = (target, pointerType = "touch") => listeners.pointerdown?.({ pointerType, target })
  const doubleTap = (first, second, pointerType) => {
    tap(first, pointerType)
    tap(second, pointerType)
    listeners.dblclick?.({ clientX: 10, clientY: 20 })
  }
  return { presses, doubleTap, selection }
}

test("a touch double tap on text selects the word at once and asks for a long press there in WebView pixels", () => {
  const { presses, doubleTap, selection } = load()
  doubleTap(new FakeElement(true), new FakeElement(true))
  assert.deepEqual(selection.calls, [
    ["collapse", "text@10,20", 2],
    ["modify", "move", "backward", "word"],
    ["modify", "extend", "forward", "word"]
  ])
  assert.deepEqual(presses, [{ x: 30, y: 60 }])
})

test("a mouse double click keeps the browser's own word selection", () => {
  const { presses, doubleTap } = load()
  doubleTap(new FakeElement(true), new FakeElement(true), "mouse")
  assert.deepEqual(presses, [])
})

test("a double tap whose first tap opened a collapsed comment only opens it", () => {
  const { presses, doubleTap } = load()
  doubleTap(new FakeElement(false), new FakeElement(true))
  assert.deepEqual(presses, [])
})

test("off Android the shell's browser already selects on a double tap", () => {
  const { presses, doubleTap } = load("ios")
  doubleTap(new FakeElement(true), new FakeElement(true))
  assert.deepEqual(presses, [])
})
