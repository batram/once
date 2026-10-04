const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const root = path.resolve(__dirname, "../../..")

function load() {
  const source = fs.readFileSync(path.join(root, "apps/mobile/src/addressMenu.ts"), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const moduleObject = { exports: {} }
  Function("exports", "module", "require", compiled)(moduleObject.exports, moduleObject, () => ({
    Capacitor: { isNativePlatform: () => false },
    registerPlugin: () => { throw new Error("not native") }
  }))
  return moduleObject.exports
}

function field(value) {
  const address = new EventTarget()
  address.value = value
  return address
}

test("the native menu learns whether the focused address field has text", async () => {
  const address = field("https://example.com/")
  const states = []
  const listeners = {}
  const plugin = {
    setEditing: async state => { states.push(state) },
    addListener: async (event, listener) => {
      listeners[event] = listener
      return { remove: async () => undefined }
    }
  }
  const went = []
  let cleared = 0
  load().installAddressMenu(address, { go: text => went.push(text), clear: () => { cleared += 1 } }, plugin)
  await Promise.resolve()

  address.dispatchEvent(new Event("focus"))
  address.value = ""
  address.dispatchEvent(new Event("input"))
  address.dispatchEvent(new Event("blur"))
  assert.deepEqual(states, [
    { editing: true, hasText: true },
    { editing: true, hasText: false },
    { editing: false, hasText: false }
  ])

  listeners.pasteAndGo({ text: "  example.com/a \n" })
  listeners.pasteAndGo({ text: "   " })
  assert.deepEqual(went, ["example.com/a"], "blank clipboard text does not navigate")
  listeners.clear()
  assert.equal(cleared, 1)
})

test("clearing falls back to resetting the value and still reports the edit", () => {
  const address = field("https://example.com/long/path")
  const calls = []
  address.focus = () => calls.push("focus")
  address.select = () => calls.push("select")
  address.addEventListener("input", () => calls.push("input"))
  globalThis.document = { execCommand: () => false }
  try {
    load().clearAddress(address)
  } finally {
    delete globalThis.document
  }
  assert.equal(address.value, "")
  assert.deepEqual(calls, ["focus", "select", "input"])
})

test("the web build has no native menu to decorate", () => {
  assert.doesNotThrow(() => load().installAddressMenu(field(""), { go() {}, clear() {} }))
})
