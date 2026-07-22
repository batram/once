const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

// damp(dy) = maxPull * (1 - e^(-dy/maxPull)); with the defaults (threshold 64,
// maxPull 96) a downward drag must exceed ~106px to cross the trigger.
function withDom(run) {
  const { window } = parseHTML(`
    <div id="stories_panel">
      <div class="stories_container" id="stories"></div>
    </div>
  `)
  const prevDocument = globalThis.document
  const prevElement = globalThis.Element
  globalThis.document = window.document
  globalThis.Element = window.Element
  // linkedom doesn't implement scrollTop; the gesture reads it to detect
  // "at the top", so seed it (0 = scrolled to top).
  window.document.querySelector("#stories").scrollTop = 0
  try {
    const { attachPullToRefresh } = require(
      "../../../packages/ui-web/dist/PullToRefresh"
    )
    return run(window, attachPullToRefresh)
  } finally {
    if (prevDocument === undefined) Reflect.deleteProperty(globalThis, "document")
    else globalThis.document = prevDocument
    if (prevElement === undefined) Reflect.deleteProperty(globalThis, "Element")
    else globalThis.Element = prevElement
  }
}

function touch(window, type, x, y) {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  event.touches = type === "touchend" ? [] : [{ clientX: x, clientY: y }]
  return event
}

test("pulling past the threshold triggers a refresh and spins the icon", () => {
  // NOTE: linkedom does not reflect inline style.height back on read, so this
  // asserts on behaviour (preventDefault + refresh + spinner class) rather than
  // the pixel height. The height drive itself is plain style assignment that
  // works in a real browser/WebView.
  withDom((window, attachPullToRefresh) => {
    const stories = document.querySelector("#stories")
    let refreshes = 0
    attachPullToRefresh(stories, () => {
      refreshes++
      return Promise.resolve()
    })

    const indicator = document.querySelector(".ptr-indicator")
    assert.ok(indicator, "indicator is inserted before the list")
    assert.equal(indicator.nextElementSibling, stories)

    stories.dispatchEvent(touch(window, "touchstart", 100, 100))
    const move = touch(window, "touchmove", 100, 300) // dy 200 -> ~84px pull
    stories.dispatchEvent(move)
    assert.equal(
      move.defaultPrevented,
      true,
      "an engaged pull cancels the native overscroll"
    )

    stories.dispatchEvent(touch(window, "touchend", 100, 300))
    assert.equal(refreshes, 1, "refresh fires once on release past threshold")
    assert.ok(
      indicator.querySelector(".ptr-icon").classList.contains("rotating"),
      "icon spins while refreshing"
    )
  })
})

test("a short pull below the threshold does not refresh", () => {
  withDom((window, attachPullToRefresh) => {
    const stories = document.querySelector("#stories")
    let refreshes = 0
    attachPullToRefresh(stories, () => {
      refreshes++
    })

    stories.dispatchEvent(touch(window, "touchstart", 100, 100))
    stories.dispatchEvent(touch(window, "touchmove", 100, 150)) // dy 50 -> ~39px
    stories.dispatchEvent(touch(window, "touchend", 100, 150))

    assert.equal(refreshes, 0)
  })
})

test("a horizontal-dominant move is left for the row swipe handlers", () => {
  withDom((window, attachPullToRefresh) => {
    const stories = document.querySelector("#stories")
    let refreshes = 0
    let prevented = false
    attachPullToRefresh(stories, () => {
      refreshes++
    })

    stories.dispatchEvent(touch(window, "touchstart", 100, 100))
    const move = touch(window, "touchmove", 300, 110) // dx 200 >> dy 10
    stories.dispatchEvent(move)
    prevented = move.defaultPrevented
    stories.dispatchEvent(touch(window, "touchend", 300, 110))

    assert.equal(refreshes, 0)
    assert.equal(prevented, false, "does not hijack a horizontal swipe")
  })
})
