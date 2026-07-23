// Pull-to-refresh for a scrollable list.
//
// Touch-only by nature — a mouse never fires touch events — so this stays inert
// on desktop web/electron while giving touch platforms (the mobile app, touch
// laptops) the classic "pull down past the top to reload" gesture. The reload
// button remains the affordance for pointer users.
//
// The indicator is inserted as a flow sibling *before* the scroller, so growing
// its height slides the list down instead of transforming the scroller. That
// avoids overflow/transform hacks and never interferes with the horizontal
// `.story` swipe handlers living inside the scroller.

import {
  beginTouchGesture,
  endTouchGesture,
  updateTouchGesture
} from "./TouchGestureLock"

export interface PullToRefreshOptions {
  // Pull distance (px) required to trigger a refresh, and the resting height of
  // the spinner strip while refreshing.
  threshold?: number
  // Upper bound of the (damped) travel — the list can be pulled this far.
  maxPull?: number
}

export function attachPullToRefresh(
  scroller: HTMLElement,
  onRefresh: () => Promise<void> | void,
  options: PullToRefreshOptions = {}
): () => void {
  const threshold = options.threshold ?? 64
  const maxPull = options.maxPull ?? 96
  if (!scroller.parentElement || scroller.dataset.ptrAttached === "true") {
    return () => {}
  }
  scroller.dataset.ptrAttached = "true"

  const indicator = document.createElement("div")
  indicator.className = "ptr-indicator"
  indicator.setAttribute("aria-hidden", "true")

  const surface = document.createElement("div")
  surface.className = "ptr-surface"

  const icon = document.createElement("span")
  icon.className = "ptr-icon"
  surface.append(icon)
  indicator.append(surface)
  scroller.before(indicator)

  let startY = 0
  let startX = 0
  let pull = 0
  let armed = false
  let pulling = false
  let refreshing = false

  // Resistance curve: asymptotes toward maxPull for a rubber-band feel that
  // travels noticeably further than the horizontal swipe ("stories") effect.
  const damp = (dy: number): number => maxPull * (1 - Math.exp(-dy / maxPull))

  const render = (px: number, spinning: boolean): void => {
    indicator.style.height = `${px}px`
    const progress = Math.min(px / threshold, 1)
    surface.style.opacity = `${progress}`
    surface.style.transform = `translateY(${Math.max(0, 8 - px / 8)}px) scale(${0.75 + progress * 0.25})`
    if (spinning) {
      icon.classList.add("rotating")
      icon.style.transform = ""
      icon.style.opacity = "1"
      return
    }
    icon.classList.remove("rotating")
    icon.style.transform = `rotate(${(px / maxPull) * 360}deg)`
    icon.style.opacity = `${Math.min(px / threshold, 1)}`
  }

  const close = (): void => {
    indicator.style.transition = "height 200ms ease"
    indicator.style.height = "0px"
    const done = (): void => {
      indicator.style.transition = ""
      icon.classList.remove("rotating")
      icon.style.transform = ""
      icon.style.opacity = "0"
      surface.style.opacity = "0"
      surface.style.transform = ""
      indicator.removeEventListener("transitionend", done)
    }
    indicator.addEventListener("transitionend", done)
  }

  const runRefresh = async (): Promise<void> => {
    try {
      await onRefresh()
    } catch {
      // reload() surfaces its own errors; the gesture only needs to close.
    } finally {
      refreshing = false
      close()
    }
  }

  const onStart = (event: TouchEvent): void => {
    if (refreshing || event.touches.length !== 1) {
      return
    }
    const touch = event.touches[0]
    if (!touch) {
      return
    }
    startY = touch.clientY
    startX = touch.clientX
    beginTouchGesture(scroller, startX, startY)
    armed = scroller.scrollTop <= 0
    pulling = false
    pull = 0
  }

  const onMove = (event: TouchEvent): void => {
    if (refreshing) {
      return
    }
    const touch = event.touches[0]
    if (!touch) {
      return
    }
    const dy = touch.clientY - startY
    const axis = updateTouchGesture(
      scroller,
      touch.clientX,
      touch.clientY
    )

    if (!pulling) {
      if (axis === "pending") {
        return
      }
      // The axis stays locked until release, so a scroll/pull cannot turn into
      // a story swipe (or vice versa) after the gesture has started.
      if (axis === "horizontal" || !armed || dy <= 0) {
        armed = false
        return
      }
      if (scroller.scrollTop > 0) {
        armed = false
        return
      }
      pulling = true
      indicator.style.transition = "none"
    }

    // Cancel the native overscroll so the list follows the finger.
    event.preventDefault()
    pull = damp(dy)
    render(pull, false)
  }

  const onEnd = (): void => {
    endTouchGesture(scroller)
    if (!pulling) {
      armed = false
      return
    }
    pulling = false
    armed = false

    if (pull >= threshold) {
      refreshing = true
      indicator.style.transition = "height 200ms ease"
      render(threshold, true)
      void runRefresh()
      return
    }
    close()
  }

  scroller.addEventListener("touchstart", onStart, { passive: true })
  scroller.addEventListener("touchmove", onMove, { passive: false })
  scroller.addEventListener("touchend", onEnd, { passive: true })
  scroller.addEventListener("touchcancel", onEnd, { passive: true })

  return () => {
    scroller.removeEventListener("touchstart", onStart)
    scroller.removeEventListener("touchmove", onMove)
    scroller.removeEventListener("touchend", onEnd)
    scroller.removeEventListener("touchcancel", onEnd)
    indicator.remove()
    delete scroller.dataset.ptrAttached
  }
}
