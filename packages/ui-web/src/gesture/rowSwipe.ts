/** One direction of a row swipe: what it reveals, says, and runs on release. */
export interface RowSwipeAction {
  /** Value of `data-swipe-direction` while the row is dragged this way. */
  direction: string
  /** Selector, inside the row, of the control a committed swipe clicks. */
  action: string
  /** Hint text while the drag is short of the threshold, then once past it. */
  idle: string
  ready: string
}

export interface RowSwipeOptions {
  /** Selector of a swipeable row; the press must land inside one. */
  row: string
  /** Controls a press on which never starts a swipe, such as a close button. */
  ignore?: string
  /** Selector of the row's hint element, which shows the direction's text. */
  hint: string
  left: RowSwipeAction
  right: RowSwipeAction
  /** Runs once a gesture ends, after any action its release committed. */
  onIdle?: () => void
}

export interface RowSwipe {
  cancel(): void
  dispose(): void
  readonly active: boolean
}

/** Horizontal travel that commits on release. */
const THRESHOLD = 72
/** How far a row follows the finger. */
const REVEAL_MAX = 112

/**
 * One-stage row gestures, shared by the tab list and History: a horizontal
 * drag moves the row's content aside to reveal its action and commits on
 * release. The row exposes `data-swipe-direction`, `data-swipe-ready` and the
 * `--row-swipe-offset` / `--row-swipe-distance` variables for its stylesheet.
 */
export function attachRowSwipe(rows: HTMLElement, options: RowSwipeOptions): RowSwipe {
  let gesture: { row: HTMLElement; pointer: number; x: number; y: number; horizontal: boolean; travel: number } | null = null
  let suppressClickUntil = 0
  const onIdle = options.onIdle ?? (() => undefined)

  const reset = (): void => {
    if (!gesture) return
    const { row, pointer } = gesture
    gesture = null
    delete row.dataset.swipeDirection
    delete row.dataset.swipeReady
    row.style.removeProperty("--row-swipe-offset")
    row.style.removeProperty("--row-swipe-distance")
    if (row.hasPointerCapture(pointer)) row.releasePointerCapture(pointer)
    queueMicrotask(onIdle)
  }

  const down = (event: PointerEvent): void => {
    // A second finger cancels the gesture; a new primary press replaces a stale one.
    if (gesture) reset()
    if (!event.isPrimary || event.button !== 0) return
    const target = event.target as Element
    if (options.ignore && target.closest(options.ignore)) return
    const row = target.closest<HTMLElement>(options.row)
    if (!row) return
    gesture = { row, pointer: event.pointerId, x: event.clientX, y: event.clientY, horizontal: false, travel: 0 }
  }
  const move = (event: PointerEvent): void => {
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
    const action = dx < 0 ? options.left : options.right
    const ready = Math.abs(dx) >= THRESHOLD
    const offset = Math.sign(dx) * Math.min(Math.abs(dx), REVEAL_MAX)
    gesture.row.dataset.swipeDirection = action.direction
    gesture.row.dataset.swipeReady = String(ready)
    gesture.row.style.setProperty("--row-swipe-offset", `${offset}px`)
    gesture.row.style.setProperty("--row-swipe-distance", `${Math.abs(offset)}px`)
    const hint = gesture.row.querySelector<HTMLElement>(options.hint)
    if (hint) hint.textContent = ready ? action.ready : action.idle
  }
  const up = (event: PointerEvent): void => {
    if (!gesture || event.pointerId !== gesture.pointer) return
    const { row, horizontal, travel } = gesture
    if (horizontal) {
      event.preventDefault()
      suppressClickUntil = performance.now() + 400
    }
    reset()
    if (horizontal && Math.abs(travel) >= THRESHOLD && row.isConnected) {
      row.querySelector<HTMLElement>((travel < 0 ? options.left : options.right).action)?.click()
    }
  }
  const click = (event: MouseEvent): void => {
    // Keep the release's synthetic tap from acting after a cancelled drag.
    // Programmatic actions and keyboard activation have detail 0 and remain usable.
    if (event.detail && performance.now() < suppressClickUntil) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }
  const lost = (event: PointerEvent): void => {
    // Touch starts with implicit capture on the button; transferring it to the
    // row emits a lost event for that button and must not cancel the swipe.
    if (gesture && event.target === gesture.row) reset()
  }
  // A mouse released outside the rows before the drag went horizontal never reaches them.
  const release = (event: PointerEvent): void => { if (gesture && event.pointerId === gesture.pointer) reset() }

  rows.addEventListener("pointerdown", down)
  rows.addEventListener("pointermove", move)
  rows.addEventListener("pointerup", up)
  rows.addEventListener("click", click, true)
  rows.addEventListener("pointercancel", reset)
  rows.addEventListener("lostpointercapture", lost)
  rows.addEventListener("scroll", reset)
  window.addEventListener("blur", reset)
  window.addEventListener("pointerup", release)
  window.addEventListener("pointercancel", release)
  return {
    cancel: reset,
    get active() { return gesture !== null },
    dispose() {
      reset()
      rows.removeEventListener("pointerdown", down)
      rows.removeEventListener("pointermove", move)
      rows.removeEventListener("pointerup", up)
      rows.removeEventListener("click", click, true)
      rows.removeEventListener("pointercancel", reset)
      rows.removeEventListener("lostpointercapture", lost)
      rows.removeEventListener("scroll", reset)
      window.removeEventListener("blur", reset)
      window.removeEventListener("pointerup", release)
      window.removeEventListener("pointercancel", release)
    }
  }
}
