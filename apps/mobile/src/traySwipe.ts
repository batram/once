import {
  beginTouchGesture,
  endTouchGesture,
  getTouchGestureAxis,
  updateTouchGesture
} from "@once/ui-web/gesture/touchGestureLock"

type TraySwipeAction = "close" | "continue"

/** Horizontal travel (px) that commits on release. */
const DEFAULT_THRESHOLD = 72
const TRAYS = "story-item .addon_tray, #reading_addon_trays .addon_tray"
/** The shell's edge swipe owns these strips (edgeSwipe.ts). */
const EDGE_WIDTH = 24

/**
 * Swipes on an addon tray, under a story row or over the reading view: left
 * closes it, right continues its conversation in a new tab. Continuing is
 * only offered on a tray that shows its continue button: a row's, with a
 * platform surface to continue on. The reading view is already that tab.
 *
 * The tray swallows its own touches so the row's swipe actions and
 * pull-to-refresh stay out of a conversation; this listens in the capture
 * phase, ahead of that. The tray follows the finger and a small badge slides
 * out from behind the edge it uncovers, filling once a release would commit.
 * Release short of that and the tray settles back.
 *
 * Both go through the tray's own buttons, so the tray state stays owned by
 * AddonTrays and the swipe does exactly what a tap there would.
 */
export function attachTraySwipe(threshold = DEFAULT_THRESHOLD): () => void {
  let tray: HTMLElement | null = null
  let indicator: HTMLElement | null = null
  let action: TraySwipeAction | null = null
  let canContinue = false
  let startX = 0
  let progress = 0

  const reset = (): void => {
    if (!tray) return
    endTouchGesture(tray)
    delete tray.dataset.traySwipe
    delete tray.dataset.traySwipeAction
    tray.style.removeProperty("--tray-swipe-travel")
    tray.style.removeProperty("--tray-swipe-progress")
    indicator?.remove()
    tray = null
    indicator = null
    action = null
    progress = 0
  }

  const start = (event: TouchEvent): void => {
    if (tray || event.touches.length !== 1) return
    const touch = event.touches[0]
    if (!touch) return
    const target = event.target as Element | null
    const found = target?.closest<HTMLElement>(TRAYS)
    if (!found || startsElsewhere(target, found)) return
    if (touch.clientX <= EDGE_WIDTH || touch.clientX >= window.innerWidth - EDGE_WIDTH) return
    tray = found
    canContinue = Boolean(continueButton(found))
    startX = touch.clientX
    progress = 0
    beginTouchGesture(tray, touch.clientX, touch.clientY)
  }

  const move = (event: TouchEvent): void => {
    if (!tray) return
    const touch = event.touches[0]
    if (!touch) return
    const axis = updateTouchGesture(tray, touch.clientX, touch.clientY)
    if (axis === "pending") return
    if (axis === "vertical") {
      reset()
      return
    }
    if (event.cancelable) event.preventDefault()
    const delta = touch.clientX - startX
    // A tray with nowhere to continue to stays put when dragged right.
    const travel = delta > 0 && !canContinue ? 0 : delta
    const next: TraySwipeAction = travel > 0 ? "continue" : "close"
    progress = Math.min(1.25, Math.abs(travel) / threshold)
    if (next !== action) {
      indicator?.remove()
      indicator = createIndicator(next)
      tray.append(indicator)
      action = next
      tray.dataset.traySwipeAction = next
    }
    tray.dataset.traySwipe = progress >= 1 ? "armed" : "dragging"
    tray.style.setProperty("--tray-swipe-travel", `${travel.toFixed(1)}px`)
    tray.style.setProperty("--tray-swipe-progress", progress.toFixed(3))
    // The badge rides beside the finger, so a tall tray still shows it.
    const top = touch.clientY - tray.getBoundingClientRect().top
    indicator?.style.setProperty("--tray-swipe-y", `${Math.max(0, Math.min(tray.offsetHeight, top)).toFixed(1)}px`)
  }

  const end = (): void => {
    if (!tray) return
    const swiped = tray
    const committed = getTouchGestureAxis(swiped) === "horizontal" && progress >= 1 ? action : null
    reset()
    if (committed === "close") swiped.querySelector<HTMLElement>('.addon_tray_header button[aria-label="Close"]')?.click()
    else if (committed === "continue" && canContinue) continueButton(swiped)?.click()
  }

  const capture = { capture: true }
  document.addEventListener("touchstart", start, { capture: true, passive: true })
  document.addEventListener("touchmove", move, { capture: true, passive: false })
  document.addEventListener("touchend", end, capture)
  document.addEventListener("touchcancel", reset, capture)
  return () => {
    document.removeEventListener("touchstart", start, capture)
    document.removeEventListener("touchmove", move, capture)
    document.removeEventListener("touchend", end, capture)
    document.removeEventListener("touchcancel", reset, capture)
    reset()
  }
}

function continueButton(tray: HTMLElement): HTMLElement | null {
  return tray.querySelector('[data-testid="addon-tray-continue"]')
}

function createIndicator(action: TraySwipeAction): HTMLElement {
  const indicator = document.createElement("span")
  indicator.className = "tray_swipe_indicator"
  indicator.setAttribute("aria-hidden", "true")
  const glyph = document.createElement("span")
  glyph.className = `icon icon--${action === "close" ? "x" : "popout"}`
  indicator.append(glyph)
  return indicator
}

/**
 * Touches that belong to something inside the tray: the composer moves its
 * caret, and a wide code block or table scrolls sideways.
 */
function startsElsewhere(target: Element | null, tray: HTMLElement): boolean {
  if (target?.closest("textarea, input, select")) return true
  for (let node = target; node && node !== tray; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflow = getComputedStyle(node).overflowX
      if (overflow === "auto" || overflow === "scroll") return true
    }
  }
  return false
}
