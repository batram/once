const assert = require("node:assert/strict")
const test = require("node:test")
const { lite } = require("./lite-support")
const { LiteWorlds } = lite("liteWorlds")

test("restore batches scheduled updates and waits for the final native acknowledgement", async () => {
  let acknowledge
  let calls = 0
  const worlds = new LiteWorlds({ request: async () => {
    calls++
    await new Promise(resolve => { acknowledge = resolve })
  } }, () => "", () => [], () => "en", () => "token")
  let restored = false
  const restoring = worlds.batchRestore(async () => {
    await worlds.update()
    worlds.schedule()
    await worlds.flush()
    await worlds.update()
    assert.equal(calls, 0)
  }).then(() => { restored = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(restored, false)
  acknowledge()
  await restoring
  assert.equal(restored, true)
})

test("failed restore installs the surviving set and restores subsequent update behavior", async () => {
  let calls = 0
  const worlds = new LiteWorlds({ request: async () => { calls++ } }, () => "", () => [], () => "en", () => "token")
  await assert.rejects(worlds.batchRestore(async () => { await worlds.update(); throw Error("restore failed") }), /restore failed/)
  assert.equal(calls, 1)
  await worlds.update()
  assert.equal(calls, 2)
})

test("a rejected final registration prevents restore from reporting readiness", async () => {
  const worlds = new LiteWorlds({ request: async () => { throw Error("registration failed") } }, () => "", () => [], () => "en", () => "token")
  await assert.rejects(worlds.batchRestore(async () => {}), /registration failed/)
})
