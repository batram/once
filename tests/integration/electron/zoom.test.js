const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const Module = require("node:module")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const originalTs = Module._extensions[".ts"]
Module._extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8")
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename
  }).outputText
  module._compile(output, filename)
}

const root = path.resolve(__dirname, "../../..")
const { zoomStepFor, handleZoomKey, bindWheelZoom, shellPoint, shellRect } = require(path.join(
  root, "apps/electron/src/browser/Zoom.ts"
))
Module._extensions[".ts"] = originalTs

const ctrl = process.platform === "darwin" ? { meta: true } : { control: true }

function key(key, extra = {}) {
  return {
    type: "keyDown", isAutoRepeat: false, control: false, alt: false,
    shift: false, meta: false, key, ...ctrl, ...extra
  }
}

function fakeContents(factor = 1) {
  const contents = new EventEmitter()
  contents.factor = factor
  contents.isDestroyed = () => false
  contents.getZoomFactor = () => contents.factor
  contents.setZoomFactor = (next) => { contents.factor = next }
  return contents
}

function press(contents, input) {
  let prevented = false
  const handled = handleZoomKey(contents, { preventDefault: () => { prevented = true } }, input)
  return { handled, prevented }
}

test("zoom keys match by the character produced, on any layout", () => {
  // German "+" key and numpad "+": no Shift involved.
  assert.equal(zoomStepFor(key("+")), "in")
  // US: "=" unshifted and "+" with Shift.
  assert.equal(zoomStepFor(key("=")), "in")
  assert.equal(zoomStepFor(key("+", { shift: true })), "in")
  assert.equal(zoomStepFor(key("-")), "out")
  assert.equal(zoomStepFor(key("0")), "reset")
})

test("non-zoom keys are left alone", () => {
  assert.equal(zoomStepFor(key("+", { control: false, meta: false })), null)
  // AltGr is Ctrl+Alt on Windows; it types characters, never zooms.
  assert.equal(zoomStepFor(key("0", { alt: true })), null)
  assert.equal(zoomStepFor(key("+", { type: "keyUp" })), null)
  assert.equal(zoomStepFor(key("T")), null)
})

test("zoom steps through Chromium's levels and resets", () => {
  const contents = fakeContents()
  assert.deepEqual(press(contents, key("+")), { handled: true, prevented: true })
  assert.equal(contents.factor, 1.1)
  press(contents, key("+"))
  assert.equal(contents.factor, 1.25)
  press(contents, key("-"))
  press(contents, key("-"))
  press(contents, key("-"))
  assert.equal(contents.factor, 0.9)
  press(contents, key("0"))
  assert.equal(contents.factor, 1)
  assert.deepEqual(press(contents, key("T")), { handled: false, prevented: false })
})

test("zoom stops at the ends of the range", () => {
  const contents = fakeContents(5)
  press(contents, key("+"))
  assert.equal(contents.factor, 5)
  contents.factor = 0.25
  press(contents, key("-"))
  assert.equal(contents.factor, 0.25)
})

test("Ctrl+wheel zooms through zoom-changed", () => {
  const contents = fakeContents()
  bindWheelZoom(contents)
  contents.emit("zoom-changed", {}, "in")
  assert.equal(contents.factor, 1.1)
  contents.emit("zoom-changed", {}, "out")
  contents.emit("zoom-changed", {}, "out")
  assert.equal(contents.factor, 0.9)
})

test("shell coordinates are scaled to window pixels by the shell's zoom", () => {
  const shell = fakeContents(1.1)
  assert.deepEqual(shellPoint(shell, { x: 10, y: 20 }), { x: 11, y: 22 })
  // The tab area measured live at 110%: rounding the size instead of the edges
  // left the view a pixel short of the window's bottom edge (800).
  const rect = shellRect(shell, { x: 426.264, y: 63.991, width: 737.372, height: 663.281 })
  assert.deepEqual(rect, { x: 469, y: 70, width: 811, height: 730 })
  assert.equal(rect.y + rect.height, 800)
  // Malformed input is left for the caller's validation to reject.
  assert.equal(shellRect(shell, null), null)
  assert.deepEqual(shellRect(fakeContents(1), { x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4 })
})
