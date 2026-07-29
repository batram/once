/**
 * Configuration for the two-stage story swipe.
 *
 * The row follows the pointer directly. A drag engages a stage once it passes
 * that stage's `threshold`; releasing there runs its action, while releasing
 * below stage 1 runs nothing. Thresholds are symmetric between left and right
 * — only the actions differ by direction.
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
  /** Legacy detent offset, retained for synced-settings compatibility. */
  offset: number
}

export interface SwipeSettings {
  /** false collapses the gesture to a single stage */
  twoStage: boolean
  /** magnetically settles the row around each active stage threshold */
  stickyStages: boolean
  /** strength of the magnetic stage notches, from 1 (subtle) to 100 (strong) */
  stickyStrength: number
  /** protects stage one when a fast gesture only passes through stage two */
  fastSwipeMode: boolean
  /** uninterrupted time beyond stage two before its action becomes armed */
  stage2LockInMs: number
  stages: [SwipeStageSetting, SwipeStageSetting]
  right: [SwipeActionId, SwipeActionId]
  left: [SwipeActionId, SwipeActionId]
}

export const DEFAULT_SWIPE_SETTINGS: SwipeSettings = {
  twoStage: true,
  stickyStages: false,
  stickyStrength: 65,
  fastSwipeMode: false,
  stage2LockInMs: 175,
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
const MIN_STAGE_GAP = 16
const MAX_THRESHOLD = 1000
const MAX_FIRST_STAGE = MAX_THRESHOLD - MIN_STAGE_GAP
const MIN_STICKY_STRENGTH = 1
const MAX_STICKY_STRENGTH = 100
const MIN_STAGE_2_LOCK_IN_MS = 75
const MAX_STAGE_2_LOCK_IN_MS = 500

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

function clampStickyStrength(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.round(
    Math.min(
      MAX_STICKY_STRENGTH,
      Math.max(MIN_STICKY_STRENGTH, parsed)
    )
  )
}

function clampStage2LockIn(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const clamped = Math.min(
    MAX_STAGE_2_LOCK_IN_MS,
    Math.max(MIN_STAGE_2_LOCK_IN_MS, parsed)
  )
  return Math.round(clamped / 25) * 25
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
  if (second.threshold < first.threshold + MIN_STAGE_GAP) {
    second.threshold = first.threshold + MIN_STAGE_GAP
  }
  if (second.offset < first.offset + MIN_STAGE_GAP) {
    second.offset = first.offset + MIN_STAGE_GAP
  }

  const action = (
    raw: unknown,
    fallback: SwipeActionId
  ): SwipeActionId => (isSwipeActionId(raw) ? raw : fallback)

  return {
    twoStage: source.twoStage !== false,
    stickyStages: source.stickyStages === true,
    stickyStrength: clampStickyStrength(
      source.stickyStrength,
      defaults.stickyStrength
    ),
    fastSwipeMode: source.fastSwipeMode === true,
    stage2LockInMs: clampStage2LockIn(
      source.stage2LockInMs,
      defaults.stage2LockInMs
    ),
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
