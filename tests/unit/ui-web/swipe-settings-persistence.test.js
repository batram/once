const test = require("node:test")
const assert = require("node:assert/strict")

const { DEFAULT_SWIPE_SETTINGS } = require("../../../packages/app/dist")
const { SwipeSettingsPersistence } = require(
  "../../../packages/ui-web/dist/settings/SwipeSettingsPersistence"
)

function settings(overrides = {}) {
  return {
    ...DEFAULT_SWIPE_SETTINGS,
    stages: DEFAULT_SWIPE_SETTINGS.stages.map((stage) => ({ ...stage })),
    right: [...DEFAULT_SWIPE_SETTINGS.right],
    left: [...DEFAULT_SWIPE_SETTINGS.left],
    ...overrides
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function harness(storeOverrides = {}) {
  const timers = new Map()
  let nextTimer = 1
  const writes = []
  let stored = settings()
  const store = {
    async getSwipeSettings() {
      return stored
    },
    async setSwipeSettings(value) {
      writes.push(value)
      stored = value
    },
    ...storeOverrides
  }
  const states = []
  let localChanges = 0
  const owner = new SwipeSettingsPersistence(settings(), store, {
    schedule(callback) {
      const id = nextTimer++
      timers.set(id, callback)
      return id
    },
    cancel(id) {
      timers.delete(id)
    },
    onStateChanged(state) {
      states.push(state)
    },
    onLocalChange() {
      localChanges += 1
    }
  })
  return {
    owner,
    states,
    store,
    writes,
    get localChanges() {
      return localChanges
    },
    fireTimer() {
      const [id, callback] = timers.entries().next().value
      timers.delete(id)
      callback()
    }
  }
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}

test("debounces edits into one snapshot and undoes the whole batch", async () => {
  const lab = harness()

  lab.owner.update({ stickyStages: true })
  lab.owner.update({ stickyStrength: 90 })

  assert.equal(lab.writes.length, 0)
  assert.equal(lab.owner.state.status, "saving")
  assert.equal(lab.localChanges, 2)

  lab.fireTimer()
  await settle()

  assert.equal(lab.writes.length, 1)
  assert.equal(lab.writes[0].stickyStages, true)
  assert.equal(lab.writes[0].stickyStrength, 90)
  assert.equal(lab.owner.state.canUndo, true)

  lab.owner.undo()
  assert.equal(lab.owner.state.settings.stickyStages, false)
  assert.equal(lab.owner.state.settings.stickyStrength, 65)
  lab.fireTimer()
  await settle()

  assert.equal(lab.writes.length, 2)
  assert.equal(lab.owner.state.canUndo, false)
})

test("keeps one write in flight and saves the newest queued snapshot", async () => {
  const firstWrite = deferred()
  const writes = []
  const lab = harness({
    setSwipeSettings(value) {
      writes.push(value)
      return writes.length === 1 ? firstWrite.promise : Promise.resolve()
    }
  })

  lab.owner.update({ stickyStrength: 70 })
  lab.fireTimer()
  await settle()
  lab.owner.update({ stickyStrength: 80 })
  lab.fireTimer()
  await settle()

  assert.equal(writes.length, 1)
  firstWrite.resolve()
  await settle()
  await settle()

  assert.equal(writes.length, 2)
  assert.equal(writes[1].stickyStrength, 80)
  assert.equal(lab.owner.state.status, "saved")
})

test("reports a failed write and retries the latest edit", async () => {
  let attempts = 0
  const writes = []
  const lab = harness({
    async setSwipeSettings(value) {
      attempts += 1
      writes.push(value)
      if (attempts === 1) throw new Error("offline")
    }
  })
  const originalError = console.error
  console.error = () => {}
  try {
    lab.owner.update({ stickyStrength: 70 })
    lab.fireTimer()
    await settle()
    assert.equal(lab.owner.state.status, "failed")

    lab.owner.update({ stickyStrength: 75 })
    assert.equal(lab.owner.state.status, "saving")
    lab.fireTimer()
    await settle()

    assert.equal(writes.length, 2)
    assert.equal(writes[1].stickyStrength, 75)
    assert.equal(lab.owner.state.status, "saved")
  } finally {
    console.error = originalError
  }
})

test("reconciles a deferred external change after local work completes", async () => {
  const write = deferred()
  let stored = settings()
  const lab = harness({
    async getSwipeSettings() {
      return stored
    },
    setSwipeSettings() {
      return write.promise
    }
  })

  lab.owner.update({ stickyStrength: 70 })
  stored = settings({ stickyStrength: 45 })
  lab.owner.externalSettingsChanged()
  lab.fireTimer()
  await settle()
  write.resolve()
  await settle()
  await settle()

  assert.equal(lab.owner.state.settings.stickyStrength, 45)
  assert.equal(lab.owner.state.status, "saved")
  assert.equal(lab.owner.state.canUndo, false)
})

test("ignores the settings event emitted by its own in-flight write", async () => {
  const write = deferred()
  let reads = 0
  const lab = harness({
    async getSwipeSettings() {
      reads += 1
      return settings({ stickyStrength: 20 })
    },
    setSwipeSettings() {
      return write.promise
    }
  })

  lab.owner.update({ stickyStrength: 70 })
  lab.fireTimer()
  await settle()
  lab.owner.externalSettingsChanged()
  write.resolve()
  await settle()

  assert.equal(reads, 0)
  assert.equal(lab.owner.state.settings.stickyStrength, 70)
})
