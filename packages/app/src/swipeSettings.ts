/**
 * Configuration for the two-stage detented story swipe.
 *
 * A drag engages a stage once it passes that stage's `threshold`; the row then
 * rests at `offset` until released. Releasing on a stage runs its action;
 * releasing below stage 1 runs nothing. Thresholds and offsets are symmetric
 * between left and right — only the actions differ by direction.
 */

export type SwipeActionId =
  | "none"
  | "open"
  | "open-browser"
  | "open-reader"
  | "skip"
  | "toggle-read"
  | "toggle-bookmark"
  | "filter"

export const SWIPE_ACTION_LABELS: Record<SwipeActionId, string> = {
  "none": "Nothing",
  "open": "Read · open",
  "open-browser": "Open in browser",
  "open-reader": "Open in reader",
  "skip": "Skip",
  "toggle-read": "Toggle read state",
  "toggle-bookmark": "Toggle bookmark",
  "filter": "Filter source"
}

export interface SwipeStageSetting {
  /** drag distance in px at which this stage engages */
  threshold: number
  /** distance in px the row rests at while this stage is engaged */
  offset: number
}

export interface SwipeSettings {
  /** false collapses the gesture to a single stage */
  twoStage: boolean
  stages: [SwipeStageSetting, SwipeStageSetting]
  right: [SwipeActionId, SwipeActionId]
  left: [SwipeActionId, SwipeActionId]
}

export const DEFAULT_SWIPE_SETTINGS: SwipeSettings = {
  twoStage: true,
  stages: [
    // Stage 2 sits close to its own resting offset on purpose: you have to
    // drag most of the way there before it engages, so the escalation from
    // stage 1 is deliberate rather than something you fall into.
    { threshold: 56, offset: 96 },
    { threshold: 200, offset: 216 }
  ],
  right: ["open", "open-reader"],
  left: ["skip", "filter"]
}

/** Smallest sane plateau; below this a stage is indistinguishable from a tap. */
const MIN_THRESHOLD = 16
const MAX_THRESHOLD = 1000
const MAX_FIRST_STAGE = MAX_THRESHOLD - 1

export function isSwipeActionId(value: unknown): value is SwipeActionId {
  return typeof value === "string" && value in SWIPE_ACTION_LABELS
}

function clamp(
  value: unknown,
  fallback: number,
  maximum = MAX_THRESHOLD
): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.round(Math.min(maximum, Math.max(MIN_THRESHOLD, parsed)))
}

/**
 * Settings arrive from a synced document that another (possibly older or
 * newer) client wrote, so every field is treated as untrusted. Stage 2 is
 * forced above stage 1 — an inverted pair would make stage 2 unreachable.
 */
export function normalizeSwipeSettings(value: unknown): SwipeSettings {
  const source = (value ?? {}) as Partial<SwipeSettings>
  const defaults = DEFAULT_SWIPE_SETTINGS

  const stage = (index: 0 | 1): SwipeStageSetting => {
    const raw = source.stages?.[index] ?? defaults.stages[index]
    const maximum = index === 0 ? MAX_FIRST_STAGE : MAX_THRESHOLD
    return {
      threshold: clamp(
        raw?.threshold,
        defaults.stages[index].threshold,
        maximum
      ),
      offset: clamp(raw?.offset, defaults.stages[index].offset, maximum)
    }
  }

  const first = stage(0)
  const second = stage(1)
  if (second.threshold <= first.threshold) {
    second.threshold = first.threshold + 1
  }
  if (second.offset <= first.offset) {
    second.offset = first.offset + 1
  }

  const action = (
    raw: unknown,
    fallback: SwipeActionId
  ): SwipeActionId => (isSwipeActionId(raw) ? raw : fallback)

  return {
    twoStage: source.twoStage !== false,
    stages: [first, second],
    right: [
      action(source.right?.[0], defaults.right[0]),
      action(source.right?.[1], defaults.right[1])
    ],
    left: [
      action(source.left?.[0], defaults.left[0]),
      action(source.left?.[1], defaults.left[1])
    ]
  }
}
