const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

const html = (continuable, reading) => `<!doctype html><html><body>
  <${reading ? 'div id="reading_addon_trays"' : "story-item"}><section class="addon_tray">
    <div class="addon_tray_header">
      ${continuable ? '<button data-testid="addon-tray-continue">Continue in new tab</button>' : ""}
      <button aria-label="Close"></button>
    </div>
    <p class="message">Answer</p>
    <form><textarea></textarea></form>
  </section></${reading ? "div" : "story-item"}>
</body></html>`

async function withDom(run, { continuable = true, reading = false } = {}) {
  const { window } = parseHTML(html(continuable, reading))
  window.innerWidth = 400
  const previous = { document: globalThis.document, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle }
  globalThis.document = window.document
  globalThis.window = window
  globalThis.getComputedStyle = () => ({ overflowX: "visible" })
  const tray = window.document.querySelector(".addon_tray")
  tray.getBoundingClientRect = () => ({ top: 100 })
  Object.defineProperty(tray, "offsetHeight", { value: 200 })
  const clicks = []
  tray.querySelector('[aria-label="Close"]').addEventListener("click", () => clicks.push("close"))
  tray.querySelector('[data-testid="addon-tray-continue"]')?.addEventListener("click", () => clicks.push("continue"))
  try {
    const { attachTraySwipe } = await import("../../../apps/mobile/src/traySwipe.ts")
    const detach = attachTraySwipe()
    try {
      return await run({ window, tray, clicks })
    } finally {
      detach()
    }
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

function swipe(window, target, points) {
  const [first, ...rest] = points
  target.dispatchEvent(touch(window, "touchstart", first[0], first[1]))
  for (const [x, y] of rest) target.dispatchEvent(touch(window, "touchmove", x, y))
  target.dispatchEvent(touch(window, "touchend"))
}

test("a left swipe closes the tray and a right swipe continues it", async () => {
  await withDom(({ window, tray, clicks }) => {
    const message = tray.querySelector(".message")
    swipe(window, message, [[300, 200], [270, 202], [200, 205]])
    swipe(window, message, [[100, 200], [130, 202], [200, 205]])
    assert.deepEqual(clicks, ["close", "continue"])
    assert.equal(tray.dataset.traySwipe, undefined)
    assert.equal(tray.querySelector(".tray_swipe_indicator"), null)
  })
})

test("a tray with nowhere to continue to ignores a right swipe", async () => {
  await withDom(({ window, tray, clicks }) => {
    const message = tray.querySelector(".message")
    message.dispatchEvent(touch(window, "touchstart", 100, 200))
    message.dispatchEvent(touch(window, "touchmove", 200, 200))
    assert.equal(tray.style.getPropertyValue("--tray-swipe-travel"), "0.0px")
    assert.notEqual(tray.dataset.traySwipe, "armed")
    message.dispatchEvent(touch(window, "touchend"))
    assert.deepEqual(clicks, [])
  }, { continuable: false })
})

test("the reading view's tray closes with a left swipe; with no continue there, a right swipe does nothing", async () => {
  await withDom(({ window, tray, clicks }) => {
    const message = tray.querySelector(".message")
    swipe(window, message, [[100, 200], [130, 202], [200, 205]])
    swipe(window, message, [[300, 200], [270, 202], [200, 205]])
    assert.deepEqual(clicks, ["close"])
  }, { reading: true, continuable: false })
})

test("short, vertical, composer and edge swipes do nothing", async () => {
  await withDom(({ window, tray, clicks }) => {
    const message = tray.querySelector(".message")
    swipe(window, message, [[300, 200], [280, 200], [260, 200]])
    swipe(window, message, [[200, 200], [220, 200], [240, 200]])
    swipe(window, message, [[300, 200], [296, 230], [280, 320]])
    swipe(window, tray.querySelector("textarea"), [[300, 200], [270, 200], [180, 200]])
    swipe(window, message, [[396, 200], [360, 200], [280, 200]])
    swipe(window, message, [[4, 200], [40, 200], [120, 200]])
    assert.deepEqual(clicks, [])
  })
})

test("the tray follows the finger and the badge matches the direction", async () => {
  await withDom(({ window, tray }) => {
    const message = tray.querySelector(".message")
    message.dispatchEvent(touch(window, "touchstart", 300, 200))
    const move = touch(window, "touchmove", 264, 201)
    message.dispatchEvent(move)
    assert.equal(move.defaultPrevented, true)
    assert.equal(tray.dataset.traySwipe, "dragging")
    assert.equal(tray.dataset.traySwipeAction, "close")
    assert.equal(tray.style.getPropertyValue("--tray-swipe-travel"), "-36.0px")
    assert.equal(tray.style.getPropertyValue("--tray-swipe-progress"), "0.500")
    assert.ok(tray.querySelector(".tray_swipe_indicator .icon--x"))
    assert.equal(tray.querySelector(".tray_swipe_indicator").style.getPropertyValue("--tray-swipe-y"), "101.0px")
    message.dispatchEvent(touch(window, "touchmove", 220, 201))
    assert.equal(tray.dataset.traySwipe, "armed")
    // Back across the start, the badge swaps sides.
    message.dispatchEvent(touch(window, "touchmove", 380, 201))
    assert.equal(tray.dataset.traySwipeAction, "continue")
    assert.equal(tray.querySelectorAll(".tray_swipe_indicator").length, 1)
    assert.ok(tray.querySelector(".tray_swipe_indicator .icon--popout"))
    message.dispatchEvent(touch(window, "touchcancel"))
    assert.equal(tray.dataset.traySwipe, undefined)
    assert.equal(tray.querySelector(".tray_swipe_indicator"), null)
  })
})
