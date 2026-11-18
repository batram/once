const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

/**
 * A list with the observers and frame clock the module needs, all driven by
 * hand: linkedom has no layout, so widths and frames are whatever the test
 * says they are.
 */
function load() {
  const { window } = parseHTML(
    "<html><body><div id=\"stories\"></div></body></html>"
  )
  const list = window.document.getElementById("stories")
  const state = { width: 400, frames: [], mutation: null, resize: null }
  Object.defineProperty(list, "clientWidth", { get: () => state.width })
  globalThis.window = window
  globalThis.document = window.document
  globalThis.requestAnimationFrame = (callback) => state.frames.push(callback)
  globalThis.MutationObserver = class {
    constructor(callback) { state.mutation = callback }
    observe() {}
  }
  globalThis.ResizeObserver = class {
    constructor(callback) { state.resize = callback }
    observe() {}
  }
  const { keepRowHeightsMeasured } = require(
    "../../../packages/ui-web/dist/story/rowHeights"
  )
  keepRowHeightsMeasured(list)
  const frame = () => state.frames.splice(0).forEach((callback) => callback())
  const node = (nodeName) => ({ nodeName })
  const mutate = (added, removed = []) =>
    state.mutation([{ addedNodes: added, removedNodes: removed }])
  return { list, state, frame, node, mutate }
}

const quiet = () => new Promise((resolve) => setTimeout(resolve, 200))

test("rows are rendered for two frames once a changed list goes quiet", async () => {
  const { list, frame, node, mutate } = load()

  mutate([node("STORY-ITEM")])
  assert.equal(list.dataset.measuringRows, undefined)
  await quiet()
  assert.equal(list.dataset.measuringRows, "true")

  // The first frame lays the rows out and records their heights at its end;
  // only the second may let them be skipped again.
  frame()
  assert.equal(list.dataset.measuringRows, "true")
  frame()
  assert.equal(list.dataset.measuringRows, undefined)
})

test("a swipe's reveal layer coming and going measures nothing", async () => {
  const { list, node, mutate } = load()

  mutate([node("DIV")])
  mutate([], [node("DIV")])
  await quiet()
  assert.equal(list.dataset.measuringRows, undefined)
})

test("a new width measures, a new height does not", async () => {
  const { list, state, frame } = load()

  state.resize()
  await quiet()
  assert.equal(list.dataset.measuringRows, "true")
  frame()
  frame()

  // Same width again: the list was only scrolled into or filtered.
  state.resize()
  await quiet()
  assert.equal(list.dataset.measuringRows, undefined)

  state.width = 320
  state.resize()
  await quiet()
  assert.equal(list.dataset.measuringRows, "true")
})
