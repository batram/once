const test = require("node:test")
const assert = require("node:assert/strict")

const { createSwipeGeometry } = require(
  "../../../packages/ui-web/dist/story/swipe/geometry"
)

function settings(overrides = {}) {
  return {
    twoStage: true,
    stickyStages: false,
    stickyStrength: 65,
    fastSwipeMode: false,
    stage2LockInMs: 175,
    stages: [
      { threshold: 56, offset: 96 },
      { threshold: 200, offset: 216 }
    ],
    right: ["open", "open-reader"],
    left: ["skip", "filter"],
    ...overrides
  }
}

test("stage engages only once a drag passes that stage's threshold", () => {
  const geometry = createSwipeGeometry(() => settings())

  assert.equal(geometry.stage(0), 0)
  assert.equal(geometry.stage(55), 0)
  assert.equal(geometry.stage(56), 1)
  assert.equal(geometry.stage(199), 1)
  assert.equal(geometry.stage(200), 2)

  // Thresholds are symmetric; only the actions differ by direction.
  assert.equal(geometry.stage(-55), 0)
  assert.equal(geometry.stage(-56), 1)
  assert.equal(geometry.stage(-200), 2)
})

test("a single-stage gesture never reaches stage two", () => {
  const geometry = createSwipeGeometry(() => settings({ twoStage: false }))

  assert.equal(geometry.stage(56), 1)
  assert.equal(geometry.stage(500), 1)
})

test("settings are read per call, not captured", () => {
  const current = settings()
  const geometry = createSwipeGeometry(() => current)

  assert.equal(geometry.stage(60), 1)
  current.stages = [
    { threshold: 120, offset: 96 },
    { threshold: 300, offset: 216 }
  ]
  assert.equal(geometry.stage(60), 0)
})

test("display offset is the raw offset while stickiness is off", () => {
  const geometry = createSwipeGeometry(() => settings())

  assert.equal(geometry.displayOffset(0), 0)
  assert.equal(geometry.displayOffset(60), 60)
  assert.equal(geometry.displayOffset(-217), -217)
})

test("a sticky drag snaps flat inside the notch and is free outside the band", () => {
  // strength 0.65 -> capture radius 36px, snap radius 16.3px around each
  // active threshold.
  const geometry = createSwipeGeometry(() =>
    settings({ stickyStages: true })
  )

  // Inside the snap zone the row rests exactly on the threshold.
  assert.equal(geometry.displayOffset(56), 56)
  assert.equal(geometry.displayOffset(72), 56)
  assert.equal(geometry.displayOffset(40), 56)
  assert.equal(geometry.displayOffset(-72), -56)

  // Beyond every capture band the drag is untouched.
  assert.equal(geometry.displayOffset(96), 96)
  assert.equal(geometry.displayOffset(150), 150)

  // The second threshold has its own notch.
  assert.equal(geometry.displayOffset(205), 200)
})

test("sticky easing meets the raw offset at the edge of the capture band", () => {
  const geometry = createSwipeGeometry(() =>
    settings({ stickyStages: true })
  )

  // At exactly the capture radius the notch must not move the row, or the
  // row would jump the instant a drag entered the band.
  assert.ok(Math.abs(geometry.displayOffset(92) - 92) < 0.001)

  // Between the snap zone and that edge the row lags behind the finger,
  // still monotonically.
  const eased = geometry.displayOffset(85)
  assert.ok(eased > 56 && eased < 85)
  assert.ok(geometry.displayOffset(80) < eased)
})

test("plateau reports the resting offset of the engaged stage", () => {
  const geometry = createSwipeGeometry(() => settings())

  assert.equal(geometry.plateau(20), 0)
  assert.equal(geometry.plateau(60), 96)
  assert.equal(geometry.plateau(210), 216)
  assert.equal(geometry.plateau(-210), -216)
})

test("actions come from the direction's list and stage zero commits nothing", () => {
  const geometry = createSwipeGeometry(() => settings())

  assert.equal(geometry.actionAt(0, 1), "none")
  assert.equal(geometry.actionAt(0, -1), "none")
  assert.equal(geometry.actionAt(1, 1), "open")
  assert.equal(geometry.actionAt(2, 1), "open-reader")
  assert.equal(geometry.actionAt(1, -1), "skip")
  assert.equal(geometry.actionAt(2, -1), "filter")
})

test("committing works off the stage reached, not the plateau it rests on", () => {
  // A stage whose resting offset sits below its own threshold: selecting by
  // plateau would report "none" for a drag that plainly engaged stage one.
  const geometry = createSwipeGeometry(() =>
    settings({
      stages: [
        { threshold: 56, offset: 20 },
        { threshold: 200, offset: 216 }
      ]
    })
  )

  assert.equal(geometry.stage(60), 1)
  assert.equal(geometry.plateau(60), 20)
  assert.equal(geometry.stage(geometry.plateau(60)), 0)
  assert.equal(geometry.actionFor(60), "open")
})

test("actionFor follows the drag direction", () => {
  const geometry = createSwipeGeometry(() => settings())

  assert.equal(geometry.actionFor(0), "none")
  assert.equal(geometry.actionFor(20), "none")
  assert.equal(geometry.actionFor(60), "open")
  assert.equal(geometry.actionFor(-60), "skip")
  assert.equal(geometry.actionFor(-210), "filter")
})
