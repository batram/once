const test = require("node:test")
const assert = require("node:assert/strict")

const {
  createSwipeStageLock,
  SWIPE_QUIET_MS
} = require("../../../packages/ui-web/dist/story/swipe/stageLock")

const LOCK_IN_MS = 175

/**
 * The lock only asks its geometry for the lock-in duration and the action at
 * each stage, so a stub is enough to drive every phase.
 */
function stubGeometry(overrides = {}) {
  const actions = overrides.actions ?? {
    1: "skip",
    2: "filter"
  }
  return () => ({
    settings: () => ({ stage2LockInMs: overrides.lockInMs ?? LOCK_IN_MS }),
    actionAt: (stage) => actions[stage]
  })
}

function harness(overrides = {}) {
  const events = []
  let engaged = true
  const lock = createSwipeStageLock({
    geometry: stubGeometry(overrides),
    stillEngaged: () => engaged,
    onHandoff: () => events.push("handoff"),
    onArmed: () => events.push("armed")
  })
  return {
    lock,
    events,
    disengage() {
      engaged = false
    }
  }
}

test("a lock runs quiet, then offers the handoff, then arms", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { lock, events } = harness()

  lock.start(-1)
  assert.equal(lock.phase, "quiet")
  assert.equal(lock.armed, false)
  assert.equal(lock.direction, -1)

  t.mock.timers.tick(SWIPE_QUIET_MS)
  assert.equal(lock.phase, "handoff")
  assert.equal(lock.armed, false)
  assert.deepEqual(events, ["handoff"])

  t.mock.timers.tick(LOCK_IN_MS - SWIPE_QUIET_MS)
  assert.equal(lock.armed, true)
  assert.equal(lock.phase, "none")
  assert.deepEqual(events, ["handoff", "armed"])
})

test("a release before the lock-in leaves stage two unarmed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { lock, events } = harness()

  lock.start(1)
  t.mock.timers.tick(LOCK_IN_MS - 1)
  assert.equal(lock.armed, false)

  lock.clear()
  t.mock.timers.tick(1000)
  assert.deepEqual(events, ["handoff"])
  assert.equal(lock.armed, false)
  assert.equal(lock.phase, "none")
  assert.equal(lock.direction, 0)
})

test("a drag that springs back arms nothing when its timer fires", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { lock, events, disengage } = harness()

  lock.start(1)
  disengage()
  t.mock.timers.tick(1000)

  assert.deepEqual(events, [])
  assert.equal(lock.armed, false)
})

test("reversing direction restarts the lock instead of arming the old one", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { lock, events } = harness()

  lock.start(1)
  t.mock.timers.tick(LOCK_IN_MS - 10)
  assert.deepEqual(events, ["handoff"])
  assert.equal(lock.armed, false)

  lock.start(-1)
  assert.equal(lock.direction, -1)
  assert.equal(lock.phase, "quiet")

  // The first lock's remaining 10ms must not arm the reversed drag; the new
  // one starts its own quiet period from scratch.
  t.mock.timers.tick(10)
  assert.deepEqual(events, ["handoff"])
  assert.equal(lock.armed, false)

  t.mock.timers.tick(LOCK_IN_MS)
  assert.deepEqual(events, ["handoff", "handoff", "armed"])
  assert.equal(lock.armed, true)
})

test("no handoff is offered when both stages run the same action", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { lock, events } = harness({ actions: { 1: "skip", 2: "skip" } })

  lock.start(1)
  t.mock.timers.tick(SWIPE_QUIET_MS)
  assert.equal(lock.phase, "quiet")
  assert.deepEqual(events, [])

  t.mock.timers.tick(LOCK_IN_MS - SWIPE_QUIET_MS)
  assert.deepEqual(events, ["armed"])
})

test("no handoff is offered when the lock-in is shorter than the quiet period", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { lock, events } = harness({ lockInMs: SWIPE_QUIET_MS })

  lock.start(1)
  t.mock.timers.tick(SWIPE_QUIET_MS)
  assert.deepEqual(events, ["armed"])
  assert.equal(lock.phase, "none")
})
