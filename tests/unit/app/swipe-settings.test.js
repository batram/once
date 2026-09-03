const test = require("node:test")
const assert = require("node:assert/strict")

const {
  DEFAULT_SWIPE_SETTINGS,
  normalizeSwipeSettings
} = require("../../../packages/app/dist/swipeSettings")
const { isSwipeActionId } = require("../../../packages/app/dist/swipeActions")

test("defaults match the redesign's plateaus and actions", () => {
  assert.deepEqual(DEFAULT_SWIPE_SETTINGS.stages, [
    { threshold: 56, offset: 96 },
    { threshold: 200, offset: 216 }
  ])
  assert.deepEqual(DEFAULT_SWIPE_SETTINGS.right, ["open", "open-reader"])
  assert.deepEqual(DEFAULT_SWIPE_SETTINGS.left, ["skip", "filter"])
  assert.equal(DEFAULT_SWIPE_SETTINGS.twoStage, true)
  assert.equal(DEFAULT_SWIPE_SETTINGS.stickyStages, false)
  assert.equal(DEFAULT_SWIPE_SETTINGS.stickyStrength, 65)
  assert.equal(DEFAULT_SWIPE_SETTINGS.fastSwipeMode, false)
  assert.equal(DEFAULT_SWIPE_SETTINGS.stage2LockInMs, 175)
  assert.equal(DEFAULT_SWIPE_SETTINGS.undoSnackbarEnabled, true)
  assert.equal(DEFAULT_SWIPE_SETTINGS.undoSnackbarDurationMs, 5000)
})

test("missing or malformed settings fall back to the defaults", () => {
  assert.deepEqual(normalizeSwipeSettings(undefined), DEFAULT_SWIPE_SETTINGS)
  assert.deepEqual(normalizeSwipeSettings({}), DEFAULT_SWIPE_SETTINGS)
  assert.deepEqual(
    normalizeSwipeSettings({ stages: "nonsense", right: 5, left: null }),
    DEFAULT_SWIPE_SETTINGS
  )
})

test("unknown action ids are replaced rather than stored", () => {
  const settings = normalizeSwipeSettings({
    right: ["purge-everything", "open"],
    left: ["toggle-bookmark", 42]
  })
  assert.deepEqual(settings.right, ["open", "open"])
  assert.deepEqual(settings.left, ["toggle-bookmark", "filter"])
  assert.equal(isSwipeActionId("purge-everything"), false)
  assert.equal(isSwipeActionId("open-browser"), true)
  assert.equal(isSwipeActionId("toggle-bookmark"), true)
})

test("distances are clamped into a usable range", () => {
  const settings = normalizeSwipeSettings({
    stages: [
      { threshold: -20, offset: 99999 },
      { threshold: 400, offset: 500 }
    ]
  })
  assert.equal(settings.stages[0].threshold, 16)
  assert.equal(settings.stages[0].offset, 984)
  assert.equal(settings.stages[1].threshold, 400)
})

test("normalization keeps both stages within the advertised maximum", () => {
  const normalized = normalizeSwipeSettings({
    stages: [
      { threshold: 1000, offset: 1000 },
      { threshold: 1000, offset: 1000 }
    ]
  })

  assert.deepEqual(normalized.stages, [
    { threshold: 984, offset: 984 },
    { threshold: 1000, offset: 1000 }
  ])
})

test("stage 2 stays at least 16px beyond stage 1", () => {
  const settings = normalizeSwipeSettings({
    stages: [
      { threshold: 200, offset: 300 },
      { threshold: 50, offset: 60 }
    ]
  })
  assert.equal(
    settings.stages[1].threshold - settings.stages[0].threshold,
    16
  )
  assert.equal(settings.stages[1].offset - settings.stages[0].offset, 16)
})

test("twoStage only turns off when explicitly false", () => {
  assert.equal(normalizeSwipeSettings({ twoStage: false }).twoStage, false)
  assert.equal(normalizeSwipeSettings({ twoStage: undefined }).twoStage, true)
  assert.equal(normalizeSwipeSettings({ twoStage: "no" }).twoStage, true)
})

test("sticky stages are opt-in and only turn on when explicitly true", () => {
  assert.equal(normalizeSwipeSettings({ stickyStages: true }).stickyStages, true)
  assert.equal(normalizeSwipeSettings({ stickyStages: false }).stickyStages, false)
  assert.equal(normalizeSwipeSettings({ stickyStages: "yes" }).stickyStages, false)
})

test("sticky strength is configurable and clamped to its advertised range", () => {
  assert.equal(normalizeSwipeSettings({ stickyStrength: 1 }).stickyStrength, 1)
  assert.equal(normalizeSwipeSettings({ stickyStrength: 80 }).stickyStrength, 80)
  assert.equal(normalizeSwipeSettings({ stickyStrength: 500 }).stickyStrength, 100)
  assert.equal(normalizeSwipeSettings({ stickyStrength: -5 }).stickyStrength, 1)
  assert.equal(
    normalizeSwipeSettings({ stickyStrength: "invalid" }).stickyStrength,
    DEFAULT_SWIPE_SETTINGS.stickyStrength
  )
})

test("fast swipe protection is opt-in and lock-in time is normalized", () => {
  assert.equal(normalizeSwipeSettings({ fastSwipeMode: true }).fastSwipeMode, true)
  assert.equal(normalizeSwipeSettings({ fastSwipeMode: "yes" }).fastSwipeMode, false)
  assert.equal(normalizeSwipeSettings({ stage2LockInMs: 75 }).stage2LockInMs, 75)
  assert.equal(normalizeSwipeSettings({ stage2LockInMs: 176 }).stage2LockInMs, 175)
  assert.equal(normalizeSwipeSettings({ stage2LockInMs: 5 }).stage2LockInMs, 75)
  assert.equal(normalizeSwipeSettings({ stage2LockInMs: 900 }).stage2LockInMs, 500)
  assert.equal(
    normalizeSwipeSettings({ stage2LockInMs: "invalid" }).stage2LockInMs,
    DEFAULT_SWIPE_SETTINGS.stage2LockInMs
  )
})

test("mobile undo snackbar settings are normalized", () => {
  assert.equal(
    normalizeSwipeSettings({ undoSnackbarEnabled: false }).undoSnackbarEnabled,
    false
  )
  assert.equal(
    normalizeSwipeSettings({ undoSnackbarEnabled: "no" }).undoSnackbarEnabled,
    true
  )
  assert.equal(
    normalizeSwipeSettings({ undoSnackbarDurationMs: 2750 })
      .undoSnackbarDurationMs,
    3000
  )
  assert.equal(
    normalizeSwipeSettings({ undoSnackbarDurationMs: 100 }).undoSnackbarDurationMs,
    1000
  )
  assert.equal(
    normalizeSwipeSettings({ undoSnackbarDurationMs: 20000 })
      .undoSnackbarDurationMs,
    10000
  )
})
