import { SwipeActionId } from "@once/app"
import {
  getTouchGestureAxis,
  getTouchGestureStart,
  holdTouchScroll
} from "../../gesture/touchGestureLock"
import type { StoryListItem } from "../StoryListItem"
import { commitSwipeAction } from "./commit"
import { SwipeConfig, SwipeGeometry, SwipeStage } from "./geometry"
import { createSwipeTracker, SwipeTracker } from "./track"

/**
 * Turns a row into a sample the user can drag without consequences: the
 * gesture uses `geometry` instead of the live settings, and a release reports
 * the action it would have run instead of running it.
 */
export interface SwipePreview {
  geometry: SwipeGeometry
  /** Element the touch axis lock is keyed to, in place of #stories. */
  scroller: HTMLElement
  onAction(action: SwipeActionId, stage: SwipeStage): void
  onTravel?(offset: number): void
}

/** Whether `action` takes an unread row out of its place in the list. */
function leavesUnread(row: StoryListItem, action: SwipeActionId): boolean {
  if (row.story.read_state !== "unread") return false
  return action === "skip" || action === "open" || action === "toggle-read"
}

/**
 * Anchors a mouse or pen drag on the press itself.
 *
 * Taking the origin from the first pointermove instead dropped however far the
 * pointer had already travelled — with coalesced moves that is easily past
 * stage 1, which left mid-length drags resting on a plateau but committing
 * nothing.
 *
 * @returns whether this press starts a drag
 */
function startPointerDrag(e: PointerEvent, tracker: SwipeTracker): boolean {
  // Touch has its own axis-locked path. Running both pointer and touch
  // handlers lets a vertical scroll/pull move the story as well.
  if (e.pointerType === "touch") return false
  const target = e.target as HTMLElement
  if (
    e.button != 0 ||
    target.closest('[draggable="false"]')
  ) {
    e.stopPropagation()
    return false
  }
  e.preventDefault()
  tracker.anchor(e.pageX)
  document.body.style.cursor = "w-resize"
  return true
}

/**
 * Installs the two-stage swipe on a story row.
 *
 * This is the input half only: which events drive a drag, and when the
 * document-level listeners go up and come down. Where a drag rests and what it
 * commits is track.ts and the modules under it.
 */
export function attachStorySwipe(row: StoryListItem): void {
  // Read per gesture rather than captured: a preview row is configured
  // after story_html() has already installed the handlers.
  const geometry = (): SwipeGeometry => row.swipePreview?.geometry ?? SwipeConfig

  const tracker = createSwipeTracker(row, geometry, (offset) => {
    row.swipePreview?.onTravel?.(offset)
  })

  // Set while a touch swipe keeps the list from scrolling under it.
  let release_scroll: (() => void) | null = null

  const mouse_swipe = (event: MouseEvent) => {
    if (!tracker.revealed) tracker.showReveal()
    tracker.move(event.pageX)
  }

  const touch_swipe = (event: TouchEvent) => {
    const scroller =
      row.swipePreview?.scroller ?? row.closest<HTMLElement>("#stories")
    if (!scroller || getTouchGestureAxis(scroller) !== "horizontal") {
      return
    }
    const one_touch = event.touches[0]
    if (!one_touch) {
      return
    }
    event.preventDefault()
    if (!tracker.anchored) {
      // Measure from the touchstart, not from here: this handler first runs
      // once the axis lock has resolved, several moves into the gesture, and
      // a flick can cover most of its distance by then. Anchoring here threw
      // that travel away, so a swipe that visibly passed stage 1 could
      // release having registered almost nothing.
      tracker.anchor(getTouchGestureStart(scroller)?.x ?? one_touch.clientX)
      tracker.showReveal()
      release_scroll = holdTouchScroll(row)
    }
    tracker.move(one_touch.clientX)
  }

  // Releasing past a threshold fires that stage; an early release only
  // floats the row home, which makes an abandoned drag safe.
  const end_swipe = (e: Event) => {
    e.preventDefault()
    e.stopPropagation()

    const committed = tracker.stage
    const action = geometry().actionAt(committed, tracker.direction)
    // A release that sends the row away leaves it where the finger did, so
    // the exit slide carries on from there instead of first springing home.
    const leaves = !row.swipePreview && leavesUnread(row, action)
    const released_from = reset_swipe(leaves)
    if (leaves) row.holdSwipeExit(released_from)
    commit_swipe(action, committed)

    return false
  }

  const commit_swipe = (action: SwipeActionId, committed: SwipeStage) => {
    if (row.swipePreview) {
      // A sample row: say what would have happened, change nothing.
      row.swipePreview.onAction(action, committed)
      return
    }
    commitSwipeAction(row, action)
  }

  // the browser took over the gesture (e.g. Android starts scrolling):
  // reset without triggering a read/skip action
  const cancel_swipe = () => {
    reset_swipe()
  }

  // A drag escapes the row as soon as it starts, so the moves and the release
  // are followed on the document and given back on reset.
  const followers: [string, EventListener][] = [
    ["touchmove", touch_swipe as EventListener],
    ["touchend", end_swipe],
    ["touchcancel", cancel_swipe],
    ["pointerup", end_swipe],
    ["pointercancel", cancel_swipe]
  ]

  const listen = () => {
    for (const [type, handler] of followers) {
      // Not passive, or the preventDefault above would be ignored: browsers
      // treat touch listeners on the document as passive by default.
      document.addEventListener(type, handler, { passive: false })
    }
    row.parentElement?.addEventListener("scroll", end_swipe)
  }

  const reset_swipe = (hold = false) => {
    const released_from = tracker.reset(hold)
    release_scroll?.()
    release_scroll = null
    document.body.style.cursor = ""
    for (const [type, handler] of followers) {
      document.removeEventListener(type, handler)
    }
    document.removeEventListener("pointermove", mouse_swipe)
    row.parentElement?.removeEventListener("scroll", end_swipe)
    return released_from
  }

  row.addEventListener("touchmove", () => {
    listen()
  })

  row.addEventListener("pointerdown", (e) => {
    if (!startPointerDrag(e, tracker)) return
    document.addEventListener("pointermove", mouse_swipe)
    listen()
  })
}
