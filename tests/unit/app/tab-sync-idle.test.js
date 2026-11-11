const test = require("node:test")
const assert = require("node:assert/strict")
const { TabSyncService } = require("../../../packages/app/dist/tabsync/TabSyncService")

const turn = () => new Promise(resolve => setImmediate(resolve))

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const reads = []
  let completed = 0
  const service = new TabSyncService({
    repository: {
      listDevices: () => new Promise(resolve => reads.push(resolve)),
      listRetirements: async () => [],
      listSends: async () => []
    },
    identity: { get: async () => ({ id: "self" }) },
    listStore: { get: async () => null },
    changed: () => { completed++ },
    reportError: (_operation, error) => { throw error },
    timing: { refresh: 10 }
  })
  t.after(() => service.dispose())
  return { service, reads, completed: () => completed }
}

for (const action of ["reschedule", "dispose"]) {
  test(`whenIdle waits for a running refresh after ${action}`, async t => {
    const { service, reads, completed } = fixture(t)
    service.refreshSoon()
    t.mock.timers.tick(10)
    assert.equal(reads.length, 1)
    if (action === "reschedule") {
      service.refreshSoon()
      t.mock.timers.tick(10)
      assert.equal(reads.length, 2)
      reads[1]([])
    } else service.dispose()
    let idle = false
    const waiting = service.whenIdle().then(() => { idle = true })
    await turn()
    assert.equal(idle, false, "the first read is still running")
    reads[0]([])
    await waiting
    assert.equal(completed(), action === "reschedule" ? 2 : 1)
  })
}

test("replaced and cancelled refresh timers leave no pending work", async t => {
  const { service, reads } = fixture(t)
  service.refreshSoon()
  service.refreshSoon()
  service.dispose()
  await service.whenIdle()
  t.mock.timers.tick(10)
  assert.equal(reads.length, 0)
})
