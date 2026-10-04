export interface ReadingTabSwipe {
  cancel(): void
  readonly active: boolean
}

/**
 * One-stage tab gestures: horizontal drags reveal their action and commit on release.
 * `onIdle` runs once a gesture ends, after any action its release committed.
 */
export function attachReadingTabSwipe(rows: HTMLElement, onIdle: () => void = () => undefined): ReadingTabSwipe {
  let gesture: { row: HTMLElement; pointer: number; x: number; y: number; horizontal: boolean; travel: number } | null = null
  let suppressClickUntil = 0
  const threshold = 72

  const reset = (): void => {
    if (!gesture) return
    const { row, pointer } = gesture
    gesture = null
    delete row.dataset.swipeDirection
    delete row.dataset.swipeReady
    row.style.removeProperty("--tab-swipe-offset")
    row.style.removeProperty("--tab-swipe-distance")
    if (row.hasPointerCapture(pointer)) row.releasePointerCapture(pointer)
    queueMicrotask(onIdle)
  }

  rows.addEventListener("pointerdown", event => {
    if (gesture) { reset(); return }
    if (!event.isPrimary || event.button !== 0) return
    const target = event.target as Element
    if (target.closest('[data-action="close"]')) return
    const row = target.closest<HTMLElement>(".reading_tab_row")
    if (!row) return
    gesture = { row, pointer: event.pointerId, x: event.clientX, y: event.clientY, horizontal: false, travel: 0 }
  })
  rows.addEventListener("pointermove", event => {
    if (!gesture || event.pointerId !== gesture.pointer) return
    const dx = event.clientX - gesture.x
    const dy = event.clientY - gesture.y
    if (!gesture.row.isConnected) { reset(); return }
    if (!gesture.horizontal) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return
      if (Math.abs(dy) >= Math.abs(dx)) { reset(); return }
      gesture.horizontal = true
      gesture.row.setPointerCapture(event.pointerId)
    }
    event.preventDefault()
    gesture.travel = dx
    const direction = dx < 0 ? "close" : "open"
    const ready = Math.abs(dx) >= threshold
    const offset = Math.sign(dx) * Math.min(Math.abs(dx), 112)
    gesture.row.dataset.swipeDirection = direction
    gesture.row.dataset.swipeReady = String(ready)
    gesture.row.style.setProperty("--tab-swipe-offset", `${offset}px`)
    gesture.row.style.setProperty("--tab-swipe-distance", `${Math.abs(offset)}px`)
    const hint = gesture.row.querySelector<HTMLElement>(".reading_tab_swipe_hint")
    if (hint) hint.textContent = ready ? `Release to ${direction}` : direction === "close" ? "Close tab" : "Open tab"
  })
  rows.addEventListener("pointerup", event => {
    if (!gesture || event.pointerId !== gesture.pointer) return
    const { row, horizontal, travel } = gesture
    if (horizontal) {
      event.preventDefault()
      suppressClickUntil = performance.now() + 400
    }
    reset()
    if (horizontal && Math.abs(travel) >= threshold && row.isConnected) {
      row.querySelector<HTMLButtonElement>(`[data-action="${travel < 0 ? "close" : "select"}"]`)?.click()
    }
  })
  rows.addEventListener("click", event => {
    // Keep the release's synthetic tap from opening a tab after a cancelled drag.
    // Programmatic actions and keyboard activation have detail 0 and remain usable.
    if (event.detail && performance.now() < suppressClickUntil) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }, true)
  rows.addEventListener("pointercancel", reset)
  rows.addEventListener("lostpointercapture", event => {
    // Touch starts with implicit capture on the button; transferring it to the
    // row emits a lost event for that button and must not cancel the swipe.
    if (gesture && event.target === gesture.row) reset()
  })
  rows.addEventListener("scroll", reset)
  window.addEventListener("blur", reset)
  return { cancel: reset, get active() { return gesture !== null } }
}
