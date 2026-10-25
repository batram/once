export type TouchGestureAxis = "pending" | "horizontal" | "vertical"

interface TouchGesture {
  axis: TouchGestureAxis
  startX: number
  startY: number
}

const gestures = new WeakMap<HTMLElement, TouchGesture>()
const directionSlop = 8

export function beginTouchGesture(
  scroller: HTMLElement,
  x: number,
  y: number
): void {
  gestures.set(scroller, { axis: "pending", startX: x, startY: y })
}

export function updateTouchGesture(
  scroller: HTMLElement,
  x: number,
  y: number
): TouchGestureAxis {
  const gesture = gestures.get(scroller)
  if (!gesture || gesture.axis !== "pending") {
    return gesture?.axis ?? "pending"
  }

  const dx = Math.abs(x - gesture.startX)
  const dy = Math.abs(y - gesture.startY)
  if (Math.max(dx, dy) < directionSlop) {
    return "pending"
  }

  gesture.axis = dx > dy ? "horizontal" : "vertical"
  return gesture.axis
}

/**
 * Where the gesture started. Handlers that only run once the axis has locked
 * (the story swipe) measure from here, so the travel spent resolving the
 * direction still counts towards the gesture.
 */
export function getTouchGestureStart(
  scroller: HTMLElement
): { x: number, y: number } | undefined {
  const gesture = gestures.get(scroller)
  return gesture ? { x: gesture.startX, y: gesture.startY } : undefined
}

export function getTouchGestureAxis(
  scroller: HTMLElement
): TouchGestureAxis {
  return gestures.get(scroller)?.axis ?? "pending"
}

/** Whether a finger is down on `scroller`, from touchstart until release. */
export function isTouchGestureActive(scroller: HTMLElement): boolean {
  return gestures.has(scroller)
}

export function endTouchGesture(scroller: HTMLElement): void {
  gestures.delete(scroller)
}

/**
 * Stops the lists around `element` scrolling for the rest of a touch that
 * turned out to be a sideways swipe.
 *
 * An iOS overflow scroller has no directional lock: it pans with any vertical
 * drift of the finger, and it may already have started during the slop before
 * the axis resolved, after which the swipe's preventDefault no longer counts.
 * Android rails a mostly sideways pan, so a vertical list never moves there.
 * Turning the scroller's overflow off is what WebKit honours mid-gesture: it
 * disables the native scroll view, which ends its pan and any momentum.
 *
 * @returns the release, which gives each scroller its own overflow back
 */
export function holdTouchScroll(element: HTMLElement): () => void {
  const held: [HTMLElement, string][] = []
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow !== "auto" && overflow !== "scroll") continue
    held.push([node, node.style.overflowY])
    node.style.overflowY = "hidden"
  }
  return () => {
    for (const [node, overflow] of held) node.style.overflowY = overflow
    held.length = 0
  }
}
