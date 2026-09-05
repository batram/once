const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { parseHTML } = require("linkedom")

test("overlapping async handlers retain their own story invocation", async () => {
  const sent = []
  let receive
  const scope = { parent: { postMessage: message => sent.push(message) }, addEventListener: (_event, handler) => { receive = handler } }
  const context = vm.createContext({
    exports: {},
    Blob: function FixtureBlob(parts) { this.code = parts.join("") },
    URL: { createObjectURL: blob => `data:text/javascript,${encodeURIComponent(blob.code)}`, revokeObjectURL() {} }
  })
  new vm.Script(fs.readFileSync(path.resolve(__dirname, "../../../packages/ui-web/dist/addons/sandboxRuntime.js"), "utf8"), {
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
  }).runInContext(context)
  context.exports.startSandboxRuntime(scope)
  const send = data => receive({ source: scope.parent, data })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  send({ type: "load", protocol: 1, settings: {}, code: `export default once => {
    once.onInvoke(async (action, story) => {
      await once.fetch('https://fixture.test/' + action)
      once.notify(story, action)
    })
  }` })
  for (let attempt = 0; attempt < 20 && !sent.some(message => message.type === "ready"); attempt++) await tick()
  assert.ok(sent.some(message => message.type === "ready"), JSON.stringify(sent))
  send({ type: "invoke", requestId: 1, action: "one", story: { href: "https://fixture.test/one" } })
  send({ type: "invoke", requestId: 2, action: "two", story: { href: "https://fixture.test/two" } })
  const fetches = sent.filter(message => message.type === "op" && message.op.name === "fetch")
  for (const fetch of fetches.reverse()) { send({ type: "opResult", opId: fetch.opId, ok: true, value: {} }); await tick() }
  assert.deepEqual(sent.filter(message => message.op?.name === "notify").map(message => [message.requestId, message.op.text]), [[2, "two"], [1, "one"]])
})

test("badge updates target the owning add-on even when computation names match", () => {
  const { BadgeScheduler } = require("../../../packages/ui-web/dist/addons/badgeScheduler")
  const { document } = parseHTML('<div><span data-addon-owner="first" data-addon-badge="score">1</span><span data-addon-owner="second" data-addon-badge="score">2</span></div>')
  const previous = global.CSS
  global.CSS = { escape: value => value }
  try {
    BadgeScheduler.show(document.querySelector("div"), "second", "score", "updated")
    assert.equal(document.querySelector('[data-addon-owner="first"]').textContent, "1")
    assert.equal(document.querySelector('[data-addon-owner="second"]').textContent, "updated")
  } finally { global.CSS = previous }
})
