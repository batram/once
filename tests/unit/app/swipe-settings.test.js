const test = require("node:test")
const assert = require("node:assert/strict")

const {
  DEFAULT_SWIPE_SETTINGS,
  normalizeSwipeSettings,
  isSwipeActionId
} = require("../../../packages/app/dist/swipeSettings")

test("defaults match the redesign's plateaus and actions", () => {
  assert.deepEqual(DEFAULT_SWIPE_SETTINGS.stages, [
    { threshold: 56, offset: 96 },
    { threshold: 200, offset: 216 }
  ])
  assert.deepEqual(DEFAULT_SWIPE_SETTINGS.right, ["open", "open-reader"])
  assert.deepEqual(DEFAULT_SWIPE_SETTINGS.left, ["skip", "filter"])
  assert.equal(DEFAULT_SWIPE_SETTINGS.twoStage, true)
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
  assert.equal(settings.stages[0].offset, 999)
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
    { threshold: 999, offset: 999 },
    { threshold: 1000, offset: 1000 }
  ])
})

test("an inverted stage 2 is pushed above stage 1 so it stays reachable", () => {
  const settings = normalizeSwipeSettings({
    stages: [
      { threshold: 200, offset: 300 },
      { threshold: 50, offset: 60 }
    ]
  })
  assert.ok(settings.stages[1].threshold > settings.stages[0].threshold)
  assert.ok(settings.stages[1].offset > settings.stages[0].offset)
})

test("twoStage only turns off when explicitly false", () => {
  assert.equal(normalizeSwipeSettings({ twoStage: false }).twoStage, false)
  assert.equal(normalizeSwipeSettings({ twoStage: undefined }).twoStage, true)
  assert.equal(normalizeSwipeSettings({ twoStage: "no" }).twoStage, true)
})
