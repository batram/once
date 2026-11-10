// Low-level DOM event dispatch for gestures Playwright's own input cannot
// reproduce: the structured settings list reads native HTML5 drag events and
// raw touch events directly, and neither is driven by mouse emulation.

/**
 * Dispatch a native HTML5 drag from `source` across `target`. One DataTransfer
 * is shared by dragstart and the movement event, the way a real drag does.
 *
 * `on: "source"` fires `drag` at the source, which is how Android WebView
 * reports movement — without firing dragover on the row underneath. `on:
 * "target"` fires `dragover` at the target, the desktop path. `edge` picks
 * which half of the target the pointer lands in, and that is what decides
 * insert-before from insert-after.
 */
async function dragAcross(source, target, { on, edge }) {
  await source.evaluate((node, options) => {
    const transfer = new DataTransfer()
    node.dispatchEvent(new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer
    }))
    const bounds = options.target.getBoundingClientRect()
    const receiver = options.on === "source" ? node : options.target
    receiver.dispatchEvent(new DragEvent(
      options.on === "source" ? "drag" : "dragover",
      {
        bubbles: true,
        cancelable: true,
        clientY: options.edge === "top" ? bounds.top + 1 : bounds.bottom - 1,
        dataTransfer: transfer
      }
    ))
  }, { target: await target.elementHandle(), on, edge })
}

async function startDrag(element) {
  await element.evaluate((node) => {
    node.dispatchEvent(new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer: new DataTransfer()
    }))
  })
}

async function endDrag(element) {
  await element.evaluate((node) => {
    node.dispatchEvent(new DragEvent("dragend", {
      bubbles: true,
      cancelable: true
    }))
  })
}

// A single finger, identified by `touchId` so one gesture stays coherent from
// touchstart to touchend.
async function touchStart(element, { touchId, clientY }) {
  await element.evaluate((node, options) => {
    const touch = new Touch({
      identifier: options.touchId,
      target: node,
      clientY: options.clientY
    })
    node.dispatchEvent(new TouchEvent("touchstart", {
      bubbles: true,
      cancelable: true,
      touches: [touch],
      changedTouches: [touch]
    }))
  }, { touchId, clientY })
}

// Returns whether the handler claimed the move. An unclaimed move is the list
// scrolling; a claimed one is the drag.
async function touchMove(element, { touchId, clientY }) {
  return element.evaluate((node, options) => {
    const touch = new Touch({
      identifier: options.touchId,
      target: node,
      clientY: options.clientY
    })
    const event = new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [touch],
      changedTouches: [touch]
    })
    node.dispatchEvent(event)
    return event.defaultPrevented
  }, { touchId, clientY })
}

async function touchEnd(element, { touchId, clientY }) {
  await element.evaluate((node, options) => {
    const touch = new Touch({
      identifier: options.touchId,
      target: node,
      clientY: options.clientY
    })
    node.dispatchEvent(new TouchEvent("touchend", {
      bubbles: true,
      cancelable: true,
      touches: [],
      changedTouches: [touch]
    }))
  }, { touchId, clientY })
}

// A finger from the screen edge, as the shell's touch handlers see it. Playwright's
// touchscreen only taps, so the touch sequence is dispatched directly.
async function edgeSwipe(page, direction) {
  await page.evaluate((direction) => {
    const width = window.innerWidth
    const y = 300
    const startX = direction === "back" ? 6 : width - 6
    const travel = [30, 70, 110, 150].map(x => direction === "back" ? x : width - x)
    const target = document.elementFromPoint(startX, y) || document.body
    const fire = (type, x) => {
      const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y })
      target.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === "touchend" ? [] : [touch],
        changedTouches: [touch]
      }))
    }
    fire("touchstart", startX)
    for (const x of travel) fire("touchmove", x)
    fire("touchend", travel[travel.length - 1])
  }, direction)
}

// A real touch sequence through the browser's input pipeline, held at the end of
// its travel so the caller can inspect the revealed state. Returns the release;
// `release(true)` cancels the touch instead of lifting the finger.
async function touchDrag(page, target, dx, dy = 0) {
  const bounds = await target.boundingBox()
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
  const input = await page.context().newCDPSession(page)
  await input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
  for (let step = 1; step <= 5; step++) {
    await input.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * step / 5, y: y + dy * step / 5 }] })
  }
  return async (cancel = false) => {
    await input.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] })
    await input.detach()
  }
}

module.exports = {
  edgeSwipe,
  touchDrag,
  dragAcross,
  startDrag,
  endDrag,
  touchStart,
  touchMove,
  touchEnd
}
