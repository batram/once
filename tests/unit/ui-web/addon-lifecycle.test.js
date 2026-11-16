const test = require("node:test")
const assert = require("node:assert/strict")
const { AddonSandbox } = require("../../../packages/ui-web/dist/addons/AddonSandbox")
const { AddonReconciler } = require("../../../packages/ui-web/dist/addons/AddonReconciler")

const tick = () => new Promise(resolve => setImmediate(resolve))

function frameHarness(t) {
  const previous = { window: global.window, document: global.document, MessageChannel: global.MessageChannel }
  const frames = []
  // The host hears its frame over a private channel only; this one delivers at once.
  global.MessageChannel = function FixtureChannel() {
    const end = () => ({ onmessage: null, closed: false, postMessage(data) { if (!this.closed) this.peer.onmessage?.({ data }) }, close() { this.closed = true } })
    this.port1 = end(); this.port2 = end()
    this.port1.peer = this.port2; this.port2.peer = this.port1
  }
  global.window = { addEventListener() { throw new Error("the host must not listen for window messages") } }
  global.document = {
    createElement() {
      const frame = new EventTarget()
      frame.dataset = {}
      frame.setAttribute = () => {}
      frame.sent = []
      frame.contentWindow = { postMessage: (message, _origin, transfer) => { frame.sent.push(message); frame.port = transfer?.[0] } }
      frame.remove = () => { frame.removed = true }
      return frame
    },
    body: { append: frame => frames.push(frame) }
  }
  t.after(() => Object.assign(global, previous))
  const send = (frame, data) => frame.port.postMessage(data)
  return { frames, send }
}

test("sandbox shares readiness, recreates failed frames, and stops after three failures", async t => {
  const { frames, send } = frameHarness(t)
  const sandbox = new AddonSandbox("demo", "https://sandbox.test", "code", () => ({}), { perform() {}, report() {} })
  for (let attempt = 0; attempt < 3; attempt++) {
    const loading = sandbox.ensure()
    assert.equal(sandbox.ensure(), loading)
    const rejected = assert.rejects(loading, /broken/)
    const frame = frames.at(-1)
    frame.dispatchEvent(new Event("load"))
    await tick()
    send(frame, { type: "error", message: "broken" })
    await rejected
    assert.equal(frame.removed, true)
  }
  assert.equal(frames.length, 3)
  await assert.rejects(sandbox.ensure(), /disabled/)
  sandbox.dispose()
})

test("an add-on that navigates its frame away is stopped and its channel closed", async t => {
  const { frames, send } = frameHarness(t)
  const states = []
  const sandbox = new AddonSandbox("demo", "https://sandbox.test", "code", () => ({}), { perform() {}, report() {} }, state => states.push(state))
  const loading = sandbox.ensure()
  const frame = frames[0]
  frame.dispatchEvent(new Event("load"))
  await tick()
  assert.equal(frame.sent[0].type, "load")
  assert.ok(frame.port, "the code travels with the runtime's end of the channel")
  send(frame, { type: "ready", protocol: frame.sent[0].protocol })
  await loading
  assert.equal(states.at(-1), "running")
  frame.dispatchEvent(new Event("load"))
  assert.equal(states.at(-1), "failed")
  assert.equal(frame.removed, true)
  assert.equal(frame.port.peer.closed, true)
  sandbox.dispose()
})

test("frame navigation has a deadline and disposal settles startup", async t => {
  const { frames } = frameHarness(t)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const sandbox = new AddonSandbox("demo", "https://sandbox.test", "code", () => ({}), { perform() {}, report() {} })
  const loading = sandbox.ensure()
  const rejected = assert.rejects(loading, /in time/)
  t.mock.timers.tick(5000)
  await rejected
  assert.equal(frames[0].removed, true)
  const retry = sandbox.ensure()
  const disposed = assert.rejects(retry, /closed/)
  sandbox.dispose()
  await disposed
  await assert.rejects(sandbox.ensure(), /disposed/)
})

const candidate = (id, extras = {}) => ({ entry: {
  enabled: true, manifest: { id, collectors: [] }, ...extras
} })

test("reconciliation keeps storage writes alive and updates only the changed owner", async () => {
  const created = [], disposed = [], options = [], changed = []
  const registry = new AddonReconciler(async ({ entry }) => {
    const id = entry.manifest.id
    created.push(id)
    return { dispose: () => disposed.push(id), updateOptions: next => options.push([id, next.options]) }
  }, collectors => changed.push(collectors))
  await registry.apply([candidate("one"), candidate("two")])
  await registry.apply([candidate("one", { storage: { count: 1 } }), candidate("two")])
  assert.deepEqual(created, ["one", "two"])
  assert.deepEqual(disposed, [])
  assert.equal(changed.length, 1)
  await registry.apply([candidate("one", { options: { suffix: "!" } }), candidate("two")])
  assert.deepEqual(options, [["one", { suffix: "!" }]])
  await registry.apply([candidate("two")])
  assert.deepEqual(disposed, ["one"])
})

test("an obsolete asynchronous registration is disposed before the newer state wins", async () => {
  let finish
  const disposed = []
  const registry = new AddonReconciler(async ({ entry }) => {
    await new Promise(resolve => { finish = resolve })
    return { dispose: () => disposed.push(entry.manifest.id), updateOptions() {} }
  }, () => {})
  const old = registry.apply([candidate("old")])
  await tick()
  const latest = registry.apply([])
  finish()
  await Promise.all([old, latest])
  assert.deepEqual(disposed, ["old"])
})
