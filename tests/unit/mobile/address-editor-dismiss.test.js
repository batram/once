const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

test("native Cancel waits for keyboard hide even after focus has left the field", async () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/src/readingAddressEditor.ts"), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const calls = []
  let didHide
  const keyboard = {
    addListener: async (event, listener) => {
      assert.equal(event, "keyboardDidHide")
      didHide = listener
      calls.push("listen")
      return { remove: async () => calls.push("remove") }
    },
    hide: async () => calls.push("hide")
  }
  const moduleObject = { exports: {} }
  Function("exports", "require", "window", "document", compiled)(moduleObject.exports, name => {
    if (name === "@capacitor/core") return { Capacitor: { isNativePlatform: () => true } }
    if (name === "@capacitor/keyboard") return { Keyboard: keyboard }
    return {}
  }, { setTimeout, clearTimeout }, { activeElement: {} })
  const editor = Object.create(moduleObject.exports.ReadingAddressEditor.prototype)
  editor.dismissal = 0
  editor.field = { blur: () => calls.push("blur") }
  editor.dialog = { open: true, close: () => { calls.push("close"); editor.dialog.open = false } }
  editor.dismiss()
  await Promise.resolve()
  assert.deepEqual(calls, ["listen", "blur", "hide"])
  assert.equal(editor.dialog.open, true)
  didHide()
  await Promise.resolve()
  assert.equal(editor.dialog.open, false)
  assert.deepEqual(calls, ["listen", "blur", "hide", "remove", "close"])
})
