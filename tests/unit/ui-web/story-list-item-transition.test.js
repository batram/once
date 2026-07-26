const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

function loadTransitionModule() {
  const { window } = parseHTML("<html><body></body></html>")
  globalThis.window = window
  globalThis.document = window.document
  globalThis.Element = window.Element
  globalThis.HTMLElement = window.HTMLElement
  globalThis.customElements = window.customElements
  globalThis.MouseEvent = window.MouseEvent
  globalThis.Event = window.Event
  return {
    window,
    module: require("../../../packages/ui-web/dist/StoryExitTransition")
  }
}

function transition(window, type, propertyName, target) {
  const event = new window.Event(type)
  Object.defineProperty(event, "propertyName", { value: propertyName })
  target.dispatchEvent(event)
}

test("story exit completes when its margin transition is cancelled", () => {
  const { window, module } = loadTransitionModule()
  const row = document.createElement("div")
  let completions = 0

  module.finishStoryExitTransition(row, () => completions++, 100)
  transition(window, "transitioncancel", "margin-left", row)

  assert.equal(completions, 1)
})

test("story exit ignores unrelated transitions and has a fallback", async () => {
  const { window, module } = loadTransitionModule()
  const row = document.createElement("div")
  let completions = 0

  module.finishStoryExitTransition(row, () => completions++, 5)
  transition(window, "transitionend", "transform", row)
  assert.equal(completions, 0)

  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(completions, 1)
})

test("story exit completion can be cancelled by a replacement update", async () => {
  const { module } = loadTransitionModule()
  const row = document.createElement("div")
  let completions = 0

  const cancel = module.finishStoryExitTransition(
    row,
    () => completions++,
    5
  )
  cancel()

  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(completions, 0)
})
