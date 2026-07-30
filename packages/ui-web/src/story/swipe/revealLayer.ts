import { SWIPE_ACTION_LABELS } from "@once/app"
import { SwipeGeometry, SwipeStage } from "./geometry"
import { SWIPE_QUIET_MS, SwipeLockPhase } from "./stageLock"

export type SwipeLockState = "none" | "pending" | "armed"

/**
 * The coloured panel revealed behind a dragged row.
 *
 * It owns the whole `.bb_slide` subtree: creating it, keeping it aligned with
 * the row, writing the action labels and the `data-*` attributes that
 * stories.css styles off, and removing it when the gesture ends.
 */
export interface SwipeRevealLayer {
  /** Insert the layer if the gesture has not created it yet, then redraw. */
  ensure(offset: number, stage: SwipeStage): void
  /** True once `ensure` has built the layer for the current gesture. */
  readonly present: boolean
  update(
    offset: number,
    revealedStage: SwipeStage,
    lockState?: SwipeLockState,
    lockPhase?: SwipeLockPhase
  ): void
  remove(): void
}

function actionSpans(side: HTMLElement) {
  return {
    primary: side.querySelector<HTMLElement>(".swipe_action_primary"),
    secondary: side.querySelector<HTMLElement>(".swipe_action_secondary")
  }
}

function createSide(className: string): HTMLElement {
  const side = document.createElement("div")
  side.classList.add(className)
  side.append(
    Object.assign(document.createElement("span"), {
      className: "swipe_action_primary"
    }),
    Object.assign(document.createElement("span"), {
      className: "swipe_action_secondary"
    })
  )
  return side
}

function clearSide(side: HTMLElement): void {
  const { primary, secondary } = actionSpans(side)
  if (primary) primary.innerText = ""
  if (secondary) secondary.innerText = ""
  side.dataset.stage = "0"
  side.dataset.action = "none"
  side.dataset.lock = "none"
  side.dataset.lockPhase = "none"
  side.dataset.pendingAction = "none"
}

/**
 * @param row the dragged story row
 * @param geometry read per call: a preview row swaps its geometry after the
 *   gesture handlers are already installed
 */
export function createSwipeRevealLayer(
  row: HTMLElement,
  geometry: () => SwipeGeometry
): SwipeRevealLayer {
  let element: HTMLElement | undefined
  let left: HTMLElement | undefined
  let right: HTMLElement | undefined

  // offsetTop/offsetHeight are layout positions, unaffected by the row's own
  // transform, so the reveal stays put while the row slides across it.
  const position = () => {
    if (!element) return
    element.style.top = row.offsetTop + "px"
    element.style.height = row.offsetHeight + "px"
    element.style.lineHeight = row.offsetHeight + "px"
  }

  const layer: SwipeRevealLayer = {
    get present() {
      return element !== undefined
    },

    // The reveal is absolutely positioned over the row's own box, inside the
    // scroll container. It must not participate in layout: an in-flow sibling
    // (even one cancelled out with a negative margin) reflows the list, and
    // the rows above it visibly jump the moment a drag begins.
    ensure(offset, stage) {
      if (!element?.isConnected) {
        element = document.createElement("div")
        element.classList.add("bb_slide")
        left = createSide("swipe_left")
        right = createSide("swipe_right")
        element.append(left, right)
        // Before the row in DOM order so the row paints over it. Both sit in
        // the positioned layer — the row because of its transform.
        row.before(element)
      }
      position()
      layer.update(offset, stage)
    },

    // Reveal the first action as soon as the row moves. The stage still stays
    // at zero until its threshold, so an early release remains harmless, but
    // the gesture responds immediately instead of showing an empty gap.
    update(offset, revealedStage, lockState = "none", lockPhase = "none") {
      if (!left || !right) return
      const revealed = offset > 0 ? left : right
      const hidden = offset > 0 ? right : left
      const { primary, secondary } = actionSpans(revealed)
      if (!primary || !secondary) return

      clearSide(hidden)

      const direction = Math.sign(offset)
      const action =
        direction === 0
          ? "none"
          : geometry().actionAt(
            revealedStage === 0 ? 1 : revealedStage,
            direction
          )
      const pendingAction =
        direction === 0 ? "none" : geometry().actionAt(2, direction)
      const showHandoff =
        lockState === "pending" &&
        lockPhase === "handoff" &&
        pendingAction !== action

      primary.innerText = direction === 0 ? "" : SWIPE_ACTION_LABELS[action]
      secondary.innerText =
        showHandoff ? `Hold → ${SWIPE_ACTION_LABELS[pendingAction]}` : ""
      secondary.dataset.action = showHandoff ? pendingAction : "none"
      revealed.dataset.stage = String(revealedStage)
      revealed.dataset.lock = lockState
      revealed.dataset.lockPhase = lockPhase
      revealed.dataset.pendingAction = showHandoff ? pendingAction : "none"
      const lockInMs = geometry().settings().stage2LockInMs
      const quietMs = Math.min(SWIPE_QUIET_MS, lockInMs)
      revealed.style.setProperty(
        "--swipe-handoff-duration",
        Math.max(0, lockInMs - quietMs) + "ms"
      )
      // CSS picks the reveal colour off the action, so a reconfigured swipe
      // keeps its colour meaning instead of colouring by stage number.
      revealed.dataset.action = action
    },

    remove() {
      document.querySelectorAll<HTMLElement>(".bb_slide").forEach((el) => {
        el.remove()
      })
      element = undefined
      left = undefined
      right = undefined
    }
  }
  return layer
}
