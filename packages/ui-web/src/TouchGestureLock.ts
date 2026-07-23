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

export function getTouchGestureAxis(
  scroller: HTMLElement
): TouchGestureAxis {
  return gestures.get(scroller)?.axis ?? "pending"
}

export function endTouchGesture(scroller: HTMLElement): void {
  gestures.delete(scroller)
}
