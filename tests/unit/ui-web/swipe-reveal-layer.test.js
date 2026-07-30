const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

const LOCK_IN_MS = 175

function loadRevealLayer() {
  const { window } = parseHTML(
    "<html><body><div id=\"stories\"><div id=\"row\"></div></div></body></html>"
  )
  globalThis.window = window
  globalThis.document = window.document
  globalThis.Element = window.Element
  globalThis.HTMLElement = window.HTMLElement

  // linkedom exposes innerText read-only; the reveal writes labels through it
  // the way a browser allows. Back it with textContent for the test only.
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent
    },
    set(value) {
      this.textContent = value
    }
  })

  const { createSwipeRevealLayer } = require(
    "../../../packages/ui-web/dist/story/swipe/revealLayer"
  )
  const row = window.document.getElementById("row")
  const geometry = () => ({
    settings: () => ({ stage2LockInMs: LOCK_IN_MS }),
    actionAt: (stage, direction) =>
      direction < 0
        ? ["skip", "filter"][stage - 1]
        : ["open", "open-reader"][stage - 1]
  })
  return {
    window,
    row,
    layer: createSwipeRevealLayer(row, geometry)
  }
}

function sides(window) {
  const slide = window.document.querySelector(".bb_slide")
  return {
    slide,
    left: slide?.querySelector(".swipe_left"),
    right: slide?.querySelector(".swipe_right")
  }
}

function text(side, className) {
  return side.querySelector(`.${className}`).innerText
}

test("the layer is inserted before the row and only once per gesture", () => {
  const { window, row, layer } = loadRevealLayer()

  assert.equal(layer.present, false)
  layer.ensure(10, 0)
  assert.equal(layer.present, true)

  const { slide } = sides(window)
  assert.ok(slide)
  assert.equal(slide.nextElementSibling, row)

  layer.ensure(20, 1)
  assert.equal(window.document.querySelectorAll(".bb_slide").length, 1)
})

test("the first action is revealed as soon as the row moves", () => {
  const { window, layer } = loadRevealLayer()
  layer.ensure(5, 0)

  // Dragging right reveals the left panel, and stage zero still previews the
  // stage one action so the gesture does not open with an empty gap.
  const { left } = sides(window)
  assert.equal(text(left, "swipe_action_primary"), "Read · open")
  assert.equal(left.dataset.stage, "0")
  assert.equal(left.dataset.action, "open")
  assert.equal(left.dataset.lock, "none")
})

test("the hidden side is fully cleared when the drag reverses", () => {
  const { window, layer } = loadRevealLayer()
  layer.ensure(60, 1)
  layer.update(-60, 1)

  const { left, right } = sides(window)
  assert.equal(text(right, "swipe_action_primary"), "Skip")
  assert.equal(right.dataset.action, "skip")

  assert.equal(text(left, "swipe_action_primary"), "")
  assert.equal(text(left, "swipe_action_secondary"), "")
  assert.equal(left.dataset.stage, "0")
  assert.equal(left.dataset.action, "none")
  assert.equal(left.dataset.lock, "none")
  assert.equal(left.dataset.lockPhase, "none")
  assert.equal(left.dataset.pendingAction, "none")
})

test("a pending handoff offers the protected action without committing it", () => {
  const { window, layer } = loadRevealLayer()
  layer.ensure(-210, 1)
  layer.update(-210, 1, "pending", "handoff")

  const { right } = sides(window)
  assert.equal(text(right, "swipe_action_primary"), "Skip")
  assert.equal(text(right, "swipe_action_secondary"), "Hold → Filter source")
  assert.equal(right.dataset.stage, "1")
  assert.equal(right.dataset.lock, "pending")
  assert.equal(right.dataset.lockPhase, "handoff")
  assert.equal(right.dataset.pendingAction, "filter")
  assert.equal(
    right.style.getPropertyValue("--swipe-handoff-duration"),
    "100ms"
  )
})

test("the quiet phase of a lock shows no handoff offer", () => {
  const { window, layer } = loadRevealLayer()
  layer.ensure(-210, 1)
  layer.update(-210, 1, "pending", "quiet")

  const { right } = sides(window)
  assert.equal(text(right, "swipe_action_secondary"), "")
  assert.equal(right.dataset.lockPhase, "quiet")
  assert.equal(right.dataset.pendingAction, "none")
})

test("an armed lock reveals stage two as the committed action", () => {
  const { window, layer } = loadRevealLayer()
  layer.ensure(-210, 1)
  layer.update(-210, 2, "armed")

  const { right } = sides(window)
  assert.equal(text(right, "swipe_action_primary"), "Filter source")
  assert.equal(text(right, "swipe_action_secondary"), "")
  assert.equal(right.dataset.stage, "2")
  assert.equal(right.dataset.lock, "armed")
  assert.equal(right.dataset.action, "filter")
})

test("removing the layer clears it from the document and from the gesture", () => {
  const { window, layer } = loadRevealLayer()
  layer.ensure(10, 0)

  layer.remove()
  assert.equal(window.document.querySelectorAll(".bb_slide").length, 0)
  assert.equal(layer.present, false)

  // A later drag builds a fresh layer rather than reviving the detached one.
  layer.ensure(10, 0)
  assert.equal(window.document.querySelectorAll(".bb_slide").length, 1)
})
