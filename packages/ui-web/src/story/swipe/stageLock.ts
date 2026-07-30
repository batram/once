import { SwipeGeometry } from "./geometry"

/**
 * How long past stage two the reveal stays quiet before offering the handoff.
 * The gesture waits this out so a fast swipe that is merely passing through
 * stage two never flashes an offer at it.
 */
export const SWIPE_QUIET_MS = 75

export type SwipeLockPhase = "none" | "quiet" | "handoff"

/**
 * Fast-swipe protection for stage two.
 *
 * A flick can cross both thresholds in a couple of frames, so stage two is not
 * committed the moment it is reached. Instead the drag must rest past it for
 * `stage2LockInMs`: quiet at first, then offering "Hold → …" once it is clear
 * the user is dwelling rather than flicking. Until it arms, the gesture still
 * commits stage one — which is why the committed stage can intentionally trail
 * the visual one.
 */
export interface SwipeStageLock {
  /** True once the lock-in elapsed and stage two became committable. */
  readonly armed: boolean
  readonly phase: SwipeLockPhase
  /** The direction currently being locked, or 0 when idle. */
  readonly direction: number
  /** Begin locking for a drag in `direction`; restarts an in-flight lock. */
  start(direction: number): void
  clear(): void
}

export interface SwipeStageLockOptions {
  /** Read per call so a preview row's edited settings take effect at once. */
  geometry(): SwipeGeometry
  /**
   * Whether the drag is still resting past stage two in `direction`. Checked
   * when each timer fires: a drag that sprang back or reversed in the meantime
   * must not arm anything.
   */
  stillEngaged(direction: number): boolean
  /** Stage two is close enough to offer; the reveal shows "Hold → …". */
  onHandoff(): void
  /** Stage two is now what a release commits. */
  onArmed(): void
}

export function createSwipeStageLock(
  options: SwipeStageLockOptions
): SwipeStageLock {
  let armed = false
  let phase: SwipeLockPhase = "none"
  let direction = 0
  let armTimer: ReturnType<typeof setTimeout> | undefined
  let quietTimer: ReturnType<typeof setTimeout> | undefined

  const clearTimers = () => {
    if (armTimer !== undefined) {
      clearTimeout(armTimer)
      armTimer = undefined
    }
    if (quietTimer !== undefined) {
      clearTimeout(quietTimer)
      quietTimer = undefined
    }
  }

  return {
    get armed() {
      return armed
    },
    get phase() {
      return phase
    },
    get direction() {
      return direction
    },

    start(nextDirection) {
      clearTimers()
      direction = nextDirection
      phase = "quiet"
      armed = false

      const lockInMs = options.geometry().settings().stage2LockInMs
      const quietMs = Math.min(SWIPE_QUIET_MS, lockInMs)
      const stage1Action = options.geometry().actionAt(1, nextDirection)
      const stage2Action = options.geometry().actionAt(2, nextDirection)
      // Nothing to offer when both stages run the same action, and nothing to
      // show when the lock-in is over before the quiet period ends.
      if (quietMs < lockInMs && stage1Action !== stage2Action) {
        quietTimer = setTimeout(() => {
          quietTimer = undefined
          if (direction !== nextDirection) return
          if (!options.stillEngaged(nextDirection)) return
          phase = "handoff"
          options.onHandoff()
        }, quietMs)
      }

      armTimer = setTimeout(() => {
        armTimer = undefined
        if (quietTimer !== undefined) {
          clearTimeout(quietTimer)
          quietTimer = undefined
        }
        if (direction !== nextDirection) return
        if (!options.stillEngaged(nextDirection)) return
        armed = true
        phase = "none"
        options.onArmed()
      }, lockInMs)
    },

    clear() {
      clearTimers()
      direction = 0
      phase = "none"
      armed = false
    }
  }
}
