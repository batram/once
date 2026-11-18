const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

function load(type) {
  const { window } = parseHTML("<html><body></body></html>")
  const cleared = []
  const selection = { type, removeAllRanges: () => cleared.push(type) }
  window.document.getSelection = () => selection
  globalThis.window = window
  globalThis.document = window.document
  const { initStaleSelectionSweep } = require(
    "../../../packages/ui-web/dist/shell/staleSelection"
  )
  initStaleSelectionSweep()
  return { window, cleared, selection }
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

test("a selection nobody can see is dropped after the event has run", async () => {
  const { window, cleared } = load("None")

  window.document.body.dispatchEvent(new window.Event("click", { bubbles: true }))
  // Not yet: the handler that removes a focused field runs after this one.
  assert.deepEqual(cleared, [])
  await nextTask()
  assert.deepEqual(cleared, ["None"])
})

test("several events in one task sweep once", async () => {
  const { window, cleared } = load("None")

  for (const type of ["pointerup", "click", "keyup"]) {
    window.document.body.dispatchEvent(new window.Event(type, { bubbles: true }))
  }
  await nextTask()
  assert.equal(cleared.length, 1)
})

test("a caret or a range the user can see is left alone", async () => {
  for (const type of ["Caret", "Range"]) {
    const { window, cleared } = load(type)
    window.document.body.dispatchEvent(new window.Event("click", { bubbles: true }))
    await nextTask()
    assert.deepEqual(cleared, [])
  }
})
