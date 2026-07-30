import {
  DEFAULT_SWIPE_SETTINGS,
  SwipeActionId,
  SwipeSettings
} from "@once/app"

/**
 * Two-stage direct-manipulation swipe.
 *
 * The row tracks the pointer while thresholds select the action that will be
 * committed on release. Distances and actions are user-configurable; see
 * swipeSettings.ts.
 *
 * This module is the model alone: it maps a travel distance onto a stage, a
 * resting position, and an action. It touches no DOM, so it can be exercised
 * directly from a test with a plain settings object.
 */

export type SwipeStage = 0 | 1 | 2

/** Where a drag rests and what it commits, for one set of settings. */
export interface SwipeGeometry {
  settings(): SwipeSettings
  stage(offset: number): SwipeStage
  /** Display position after applying the optional magnetic stage notches. */
  displayOffset(offset: number): number
  plateau(offset: number): number
  actionFor(offset: number): SwipeActionId
  /**
   * What an engaged stage commits, for a drag in `direction` (-1 left,
   * 1 right). Committing works off the stage the drag reached, never off the
   * plateau it is resting on: the two only agree while every stage's resting
   * offset happens to sit past its own threshold.
   */
  actionAt(stage: SwipeStage, direction: number): SwipeActionId
}

/**
 * The geometry reads its settings through `read` on every call, so a caller
 * can drive a row from settings that are still being edited (the swipe
 * settings preview row) without touching the live configuration.
 */
export function createSwipeGeometry(
  read: () => SwipeSettings
): SwipeGeometry {
  const geometry: SwipeGeometry = {
    settings: read,

    stage(offset) {
      const distance = Math.abs(offset)
      const settings = read()
      const [first, second] = settings.stages
      if (distance < first.threshold) return 0
      if (!settings.twoStage || distance < second.threshold) return 1
      return 2
    },

    displayOffset(offset) {
      const settings = read()
      if (!settings.stickyStages || offset === 0) return offset

      // Strength expands both the magnetic approach and the flat center of
      // the notch. At the default 65 this yields a clearly felt 36px capture
      // band with a 16px snap zone; the low end remains deliberately subtle.
      const strength = settings.stickyStrength / 100
      const captureRadius = 10 + 40 * strength
      const snapRadius = 2 + 22 * strength
      const direction = Math.sign(offset)
      const distance = Math.abs(offset)
      const thresholds = settings.twoStage
        ? settings.stages.map((stage) => stage.threshold)
        : [settings.stages[0].threshold]
      const target = thresholds.find(
        (threshold) =>
          Math.abs(distance - threshold) <= captureRadius
      )
      if (target === undefined) return offset

      const delta = distance - target
      const absoluteDelta = Math.abs(delta)
      if (absoluteDelta <= snapRadius) {
        return direction * target
      }

      // Ease into and out of the notch without changing the row position at
      // the edge of its capture band. This gives the stage a tactile-feeling
      // pause while preserving direct manipulation everywhere else.
      const freeRange = captureRadius - snapRadius
      const progress = (absoluteDelta - snapRadius) / freeRange
      const attractedDistance =
        target +
        Math.sign(delta) *
          captureRadius *
          progress *
          progress
      return direction * attractedDistance
    },

    plateau(offset) {
      const stage = geometry.stage(offset)
      if (stage === 0) return 0
      return Math.sign(offset) * read().stages[stage === 1 ? 0 : 1].offset
    },

    actionFor(offset) {
      return geometry.actionAt(geometry.stage(offset), Math.sign(offset))
    },

    actionAt(stage, direction) {
      if (stage === 0) return "none"
      const settings = read()
      const actions = direction < 0 ? settings.left : settings.right
      return actions[stage === 1 ? 0 : 1]
    }
  }
  return geometry
}

/**
 * Live swipe configuration, shared by every row. Rows are created and
 * destroyed constantly, so the settings live here rather than per instance;
 * mountOnceUi seeds it and keeps it current.
 */
export const SwipeConfig: SwipeGeometry & { current: SwipeSettings } = {
  current: DEFAULT_SWIPE_SETTINGS,
  ...createSwipeGeometry(() => SwipeConfig.current)
}
