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
  const selection = {
    calls: [],
    isCollapsed: true,
    collapse(node, offset) { this.calls.push(["collapse", node, offset]); this.isCollapsed = true },
    modify(...args) { this.calls.push(["modify", ...args]); if (args[0] === "extend") this.isCollapsed = !wordUnderTap }
  }
  let wordUnderTap = true
  const document = { caretPositionFromPoint: (x, y) => ({ offsetNode: `text@${x},${y}`, offset: 2 }) }
  const moduleObject = { exports: {} }
  Function("exports", "require", "window", "document", "Element", compiled)(moduleObject.exports, name => {
    if (name === "@capacitor/core") {
      return {
        Capacitor: { getPlatform: () => platform },
        registerPlugin: () => ({ tapAt: async options => { presses.push(options) } })
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
  return { presses, doubleTap, selection, noWord: () => { wordUnderTap = false } }
}

test("a touch double tap on text selects the word and asks for a tap on it in WebView pixels", () => {
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

test("no word under the double tap, no tap: it would only place a caret", () => {
  const { presses, doubleTap, noWord } = load()
  noWord()
  doubleTap(new FakeElement(true), new FakeElement(true))
  assert.deepEqual(presses, [])
})

test("off Android no tap is asked for", () => {
  const { presses, doubleTap } = load("ios")
  doubleTap(new FakeElement(true), new FakeElement(true))
  assert.deepEqual(presses, [])
})
