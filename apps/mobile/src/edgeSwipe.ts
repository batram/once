import {
  beginTouchGesture,
  endTouchGesture,
  getTouchGestureAxis,
  updateTouchGesture
} from "@once/ui-web/gesture/touchGestureLock"

export type EdgeSwipeDirection = "back" | "forward"

export interface EdgeSwipeOptions {
  /** Called when a swipe from the left edge completes. */
  onBack(): void
  /** Called when a swipe from the right edge completes. */
  onForward(): void
  /** Whether a touch may start a swipe right now; the story list opts out. */
  enabled?(): boolean
  /** Width (px) of the strip along each screen edge that arms the gesture. */
  edgeWidth?: number
  /** Horizontal travel (px) that commits the navigation on release. */
  threshold?: number
  /**
   * Reports the gesture instead of drawing it, for a document that has no
   * indicator of its own (the Reader frame); null ends it.
   */
  onProgress?(direction: EdgeSwipeDirection | null, progress: number): void
}

const DEFAULT_EDGE_WIDTH = 24
const DEFAULT_THRESHOLD = 72

/**
 * iOS-style edge navigation for the shell: a horizontal swipe that starts at
 * the left screen edge goes back, one from the right edge goes forward.
 *
 * Only the first strip of pixels arms it, which keeps it clear of the story
 * swipe actions and pull-to-refresh, both of which start further in. The
 * native page handles its own edge swipes, and the Reader frame reports its
 * own (readerEdgeSwipe.ts), so a touch reaching the shell is outside both.
 * Commits on release; a small chevron follows the finger so the gesture has a
 * visible state.
 */
export function attachEdgeSwipe(options: EdgeSwipeOptions): () => void {
  const edgeWidth = options.edgeWidth ?? DEFAULT_EDGE_WIDTH
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  const root = document.documentElement
  const show = options.onProgress ?? createIndicator()

  let direction: EdgeSwipeDirection | null = null
  let startX = 0
  let progress = 0

  const reset = (): void => {
    direction = null
    progress = 0
    endTouchGesture(root)
    show(null, 0)
  }

  const start = (event: TouchEvent): void => {
    if (direction || event.touches.length !== 1) return
    if (options.enabled && !options.enabled()) return
    const touch = event.touches[0]
    if (!touch) return
    const target = event.target as Element | null
    // The swipe settings sample row is a horizontal gesture of its own.
    if (target?.closest('[data-swipe-preview="true"], .reading_tab_row')) return
    const width = window.innerWidth
    if (touch.clientX <= edgeWidth) direction = "back"
    else if (touch.clientX >= width - edgeWidth) direction = "forward"
    else return
    startX = touch.clientX
    progress = 0
    beginTouchGesture(root, touch.clientX, touch.clientY)
  }

  const move = (event: TouchEvent): void => {
    if (!direction) return
    const touch = event.touches[0]
    if (!touch) return
    const axis = updateTouchGesture(root, touch.clientX, touch.clientY)
    if (axis === "pending") return
    if (axis === "vertical") {
      reset()
      return
    }
    const travel = direction === "back" ? touch.clientX - startX : startX - touch.clientX
    progress = Math.max(0, Math.min(1.25, travel / threshold))
    if (event.cancelable) event.preventDefault()
    show(direction, progress)
  }

  const end = (): void => {
    if (!direction) return
    const commit = getTouchGestureAxis(root) === "horizontal" && progress >= 1
    const committed = direction
    reset()
    if (!commit) return
    if (committed === "back") options.onBack()
    else options.onForward()
  }

  document.addEventListener("touchstart", start, { passive: true })
  document.addEventListener("touchmove", move, { passive: false })
  document.addEventListener("touchend", end)
  document.addEventListener("touchcancel", reset)
  return () => {
    document.removeEventListener("touchstart", start)
    document.removeEventListener("touchmove", move)
    document.removeEventListener("touchend", end)
    document.removeEventListener("touchcancel", reset)
    reset()
    if (!options.onProgress) document.querySelector(".edge_swipe_indicator")?.remove()
  }
}

/** Draws a swipe's progress with the shell's indicator, wherever the swipe was detected. */
export function showEdgeSwipeProgress(direction: EdgeSwipeDirection | null, progress: number): void {
  const indicator = document.querySelector<HTMLElement>(".edge_swipe_indicator")
  if (!direction) {
    delete document.body.dataset.edgeSwipe
    indicator?.style.removeProperty("--edge-swipe-progress")
    return
  }
  document.body.dataset.edgeSwipe = direction
  indicator?.style.setProperty("--edge-swipe-progress", Math.max(0, Math.min(1.25, progress)).toFixed(3))
}

function createIndicator(): typeof showEdgeSwipeProgress {
  const indicator = document.createElement("div")
  indicator.className = "edge_swipe_indicator"
  indicator.setAttribute("aria-hidden", "true")
  document.body.append(indicator)
  return showEdgeSwipeProgress
}
