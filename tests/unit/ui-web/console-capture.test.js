const test = require("node:test")
const assert = require("node:assert/strict")

const modulePath = require.resolve("../../../packages/ui-web/dist/shell/consoleCapture")

// A new module instance is a new launch: fresh state, same storage.
function freshRequire(path) {
  require.cache[path] = undefined
  return require(path)
}

function launch(storage) {
  const window = new EventTarget()
  const document = new EventTarget()
  document.visibilityState = "visible"
  Object.assign(global, {
    window,
    document,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  })
  const capture = freshRequire(modulePath)
  capture.installConsoleCapture()
  return { window, document, capture }
}

test("console failures are kept across launches", (t) => {
  const { error, warn } = console
  t.after(() => {
    Object.assign(console, { error, warn })
    Object.assign(global, { window: undefined, document: undefined, localStorage: undefined })
  })
  console.error = console.warn = () => undefined
  const storage = new Map()

  const first = launch(storage)
  const failure = new Error("Failed to execute 'transaction'")
  failure.name = "InvalidStateError"
  failure.reason = { name: "AbortError" }
  console.error("Database has a global failure", failure)
  console.warn("slow")
  first.document.visibilityState = "hidden"
  first.document.dispatchEvent(new Event("visibilitychange"))

  const second = launch(storage)
  const entries = second.capture.consoleEntries()
  assert.deepEqual(entries.map(entry => entry.level), ["error", "warn"])
  assert.match(entries[0].text, /^Database has a global failure InvalidStateError: Failed to execute 'transaction'/)
  assert.match(entries[0].text, /reason: \{"name":"AbortError"\}/)
  assert.notEqual(entries[0].session, second.capture.currentConsoleSession())

  const rejection = new Event("unhandledrejection")
  rejection.reason = "offline"
  second.window.dispatchEvent(rejection)
  assert.equal(second.capture.consoleEntries().at(-1).text, "offline")
  assert.equal(second.capture.consoleEntries().at(-1).session, second.capture.currentConsoleSession())

  second.capture.clearConsoleEntries()
  assert.equal(JSON.parse(storage.get("once:console-log")).length, 0)
})
