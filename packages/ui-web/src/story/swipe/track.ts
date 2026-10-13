import { SwipeGeometry, SwipeStage } from "./geometry"
import { createSwipeRevealLayer, SwipeLockState } from "./revealLayer"
import { createSwipeStageLock } from "./stageLock"

/**
 * Springing the directly manipulated row back after a release. An animation,
 * not an inline transition: that would outlive the release and replace the
 * stylesheet's margin-left exit slide for good, leaving a skipped row blank.
 */
const SWIPE_RELEASE_TIMING: KeyframeAnimationOptions = { duration: 200, easing: "cubic-bezier(.2, .8, .2, 1)" }

/**
 * Put a dragged row back in its place for good, ending the layer promotion
 * the drag took, so the row is drawn crisp again rather than from a raster
 * made at a fractional offset.
 */
export function clearRowOffset(row: HTMLElement): void {
  row.style.transition = ""
  row.style.transform = ""
  row.classList.remove("swipe_dragging")
}

/** Move a row that rests `from` px off its place back home. */
export function springRowHome(row: HTMLElement, from: number): void {
  clearRowOffset(row)
  // spring back rather than snapping, so the release reads as a release
  if (from !== 0) {
    row.animate(
      [{ transform: `translateX(${from}px)` }, { transform: "none" }],
      SWIPE_RELEASE_TIMING
    )
  }
}

/**
 * Where a drag currently is and what releasing it would commit.
 *
 * This is the whole state of a swipe: the origin it is measured from, how far
 * it has travelled, the stage that travel selects, and the fast-swipe lock
 * protecting stage two. It knows nothing about which events drive it — see
 * gesture.ts for that — so a test can walk a drag by calling `move`.
 */
export interface SwipeTracker {
  /** True once an origin has been set, i.e. a drag is in progress. */
  readonly anchored: boolean
  /** True once the reveal behind the row exists. */
  readonly revealed: boolean
  /** The stage a release would commit right now. */
  readonly stage: SwipeStage
  /** -1 for a leftward drag, 1 for rightward, 0 before it moves. */
  readonly direction: number
  /** Fix the origin the drag is measured from. */
  anchor(x: number): void
  /** Build the panel revealed behind the row. */
  showReveal(): void
  /** Follow the pointer to `x`: redraw the reveal and move the row. */
  move(x: number): void
  /**
   * Drop all gesture state and spring the row home, or with `hold` leave it
   * where the drag left it. Returns that offset.
   */
  reset(hold?: boolean): number
}

/**
 * @param row the story row being dragged
 * @param geometry read per call: a preview row swaps its geometry after the
 *   gesture handlers are already installed
 * @param onTravel reports display travel, for the settings preview readout
 */
export function createSwipeTracker(
  row: HTMLElement,
  geometry: () => SwipeGeometry,
  onTravel: (offset: number) => void
): SwipeTracker {
  let start_offset = -1
  // Raw travel decides when stage two starts locking. Display travel may be
  // magnetically adjusted, but must never arm a protected action early.
  let raw_offset = 0
  let drag_offset = 0
  let visual_stage: SwipeStage = 0
  // The committed stage can intentionally trail the visual stage while a
  // fast swipe is passing through stage two.
  let stage: SwipeStage = 0

  const reveal = createSwipeRevealLayer(row, geometry)

  const lock = createSwipeStageLock({
    geometry,
    stillEngaged: (direction) =>
      geometry().stage(raw_offset) === 2 && Math.sign(raw_offset) === direction,
    onHandoff: () => reveal.update(drag_offset, 1, "pending", "handoff"),
    onArmed: () => {
      stage = 2
      reveal.update(drag_offset, 2, "armed")
    }
  })

  return {
    get anchored() {
      return start_offset !== -1
    },
    get revealed() {
      return reveal.present
    },
    get stage() {
      return stage
    },
    get direction() {
      return Math.sign(raw_offset)
    },

    anchor(x) {
      start_offset = x
    },

    showReveal() {
      reveal.ensure(drag_offset, visual_stage)
    },

    move(x) {
      raw_offset = x - start_offset
      drag_offset = geometry().displayOffset(raw_offset)
      const settings = geometry().settings()
      const raw_stage = geometry().stage(raw_offset)
      // Preserve magnetic stage selection in the normal mode. Fast-swipe
      // protection alone uses raw travel, so stickiness cannot preview or arm
      // its protected second action before the finger actually reaches it.
      visual_stage = settings.fastSwipeMode
        ? raw_stage
        : geometry().stage(drag_offset)
      let lockState: SwipeLockState = "none"

      if (settings.fastSwipeMode && settings.twoStage && raw_stage === 2) {
        const direction = Math.sign(raw_offset)
        if (lock.direction !== direction) lock.start(direction)
        // While the lock runs a release still commits stage one; only an
        // armed lock promotes it.
        stage = lock.armed ? 2 : 1
        lockState = lock.armed ? "armed" : "pending"
      } else {
        lock.clear()
        stage = visual_stage
      }
      reveal.update(
        drag_offset,
        lockState === "pending" ? 1 : visual_stage,
        lockState,
        lockState === "pending" ? lock.phase : "none"
      )
      // Direct manipulation is deliberately 1:1, like the platform mail and
      // list patterns: thresholds select an action but never move the row on
      // the user's behalf.
      row.style.transition = "none"
      row.classList.add("swipe_dragging")
      row.style.transform = `translateX(${drag_offset}px)`
      onTravel(drag_offset)
    },

    reset(hold = false) {
      const released_from = drag_offset
      reveal.remove()
      lock.clear()
      start_offset = -1
      raw_offset = 0
      drag_offset = 0
      visual_stage = 0
      stage = 0
      if (hold) row.style.transition = ""
      else springRowHome(row, released_from)
      onTravel(0)
      return released_from
    }
  }
}
