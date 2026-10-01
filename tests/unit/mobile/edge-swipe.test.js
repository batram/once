const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

async function withDom(run) {
  const { window } = parseHTML("<!doctype html><html><body><div id=\"left_panel\" active_panel=\"reading\"></div></body></html>")
  window.innerWidth = 400
  const previous = { document: globalThis.document, window: globalThis.window, Element: globalThis.Element }
  globalThis.document = window.document
  globalThis.window = window
  globalThis.Element = window.Element
  try {
    const { attachEdgeSwipe } = await import("../../../apps/mobile/src/edgeSwipe.ts")
    return await run(window, attachEdgeSwipe)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(globalThis, key)
      else globalThis[key] = value
    }
  }
}

function touch(window, type, x, y) {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  event.touches = type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y }]
  return event
}

function swipe(window, points) {
  const target = window.document.querySelector("#left_panel")
  const [first, ...rest] = points
  target.dispatchEvent(touch(window, "touchstart", first[0], first[1]))
  for (const [x, y] of rest) target.dispatchEvent(touch(window, "touchmove", x, y))
  target.dispatchEvent(touch(window, "touchend"))
}

test("a swipe from the left edge past the threshold goes back; the right edge goes forward", async () => {
  await withDom((window, attachEdgeSwipe) => {
    const calls = []
    const detach = attachEdgeSwipe({ onBack: () => calls.push("back"), onForward: () => calls.push("forward") })
    swipe(window, [[10, 300], [40, 302], [120, 305]])
    swipe(window, [[392, 300], [360, 302], [280, 305]])
    assert.deepEqual(calls, ["back", "forward"])
    assert.equal(window.document.body.dataset.edgeSwipe, undefined)
    detach()
    assert.equal(window.document.querySelector(".edge_swipe_indicator"), null)
  })
})

test("short, vertical and mid-screen swipes commit nothing", async () => {
  await withDom((window, attachEdgeSwipe) => {
    const calls = []
    attachEdgeSwipe({ onBack: () => calls.push("back"), onForward: () => calls.push("forward") })
    swipe(window, [[10, 300], [30, 300], [60, 300]])
    swipe(window, [[10, 300], [14, 330], [16, 420]])
    swipe(window, [[200, 300], [240, 300], [320, 300]])
    assert.deepEqual(calls, [])
  })
})

test("the indicator follows the finger and a horizontal lock cancels scrolling", async () => {
  await withDom((window, attachEdgeSwipe) => {
    attachEdgeSwipe({ onBack() {}, onForward() {} })
    const target = window.document.querySelector("#left_panel")
    target.dispatchEvent(touch(window, "touchstart", 8, 300))
    const move = touch(window, "touchmove", 44, 301)
    target.dispatchEvent(move)
    assert.equal(move.defaultPrevented, true)
    assert.equal(window.document.body.dataset.edgeSwipe, "back")
    const indicator = window.document.querySelector(".edge_swipe_indicator")
    assert.equal(indicator.style.getPropertyValue("--edge-swipe-progress"), "0.500")
    target.dispatchEvent(touch(window, "touchcancel"))
    assert.equal(window.document.body.dataset.edgeSwipe, undefined)
  })
})

test("the gesture stays inert when the host disables it", async () => {
  await withDom((window, attachEdgeSwipe) => {
    const calls = []
    attachEdgeSwipe({
      onBack: () => calls.push("back"),
      onForward: () => calls.push("forward"),
      enabled: () => false
    })
    swipe(window, [[10, 300], [40, 302], [120, 305]])
    assert.deepEqual(calls, [])
  })
})
