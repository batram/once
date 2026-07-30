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

module.exports = {
  dragAcross,
  startDrag,
  endDrag,
  touchStart,
  touchMove,
  touchEnd
}
