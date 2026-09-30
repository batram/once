const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const root = path.resolve(__dirname, "../../..")

// Only a type import, so the module transpiles and loads on its own.
function loadReloadStatus() {
  const source = fs.readFileSync(
    path.join(root, "apps/mobile/src/reloadStatus.ts"),
    "utf8"
  )
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const moduleObject = { exports: {} }
  Function("exports", "module", "require", compiled)(moduleObject.exports, moduleObject, () => ({}))
  return moduleObject.exports
}

function fixture(t, options) {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { bindReloadStatus } = loadReloadStatus()
  const handlers = new Map()
  const client = {
    subscribe(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    }
  }
  const shown = []
  const unbind = bindReloadStatus(client, (message, state) => shown.push([message, state]), options)
  const loader = (domains) => handlers.get("loaderChanged")({
    processing: domains.map((domain) => ({ domain, parserType: "rss" })),
    visible: domains.length > 0
  })
  return { shown, loader, unbind, tick: (ms) => t.mock.timers.tick(ms) }
}

test("a quick reload never reaches the status pill", (t) => {
  const { shown, loader, tick } = fixture(t)
  loader(["a.example"])
  tick(2999)
  loader([])
  tick(10000)
  assert.deepEqual(shown, [])
})

test("a slow reload reports its sources after the spin timeout, then confirms and hides", (t) => {
  const { shown, loader, tick } = fixture(t)
  loader(["a.example", "b.example"])
  tick(2999)
  assert.deepEqual(shown, [], "nothing before the timeout")
  tick(1)
  assert.deepEqual(shown, [["Loading 2 sources: a.example, b.example", "loading"]])
  loader(["b.example"])
  assert.deepEqual(shown.at(-1), ["Loading 1 source: b.example", "loading"], "follows progress once shown")
  loader([])
  assert.deepEqual(shown.at(-1), ["Stories updated", "done"])
  tick(1499)
  assert.equal(shown.length, 3)
  tick(1)
  assert.deepEqual(shown.at(-1), ["Ready", "ready"])
})

test("a reload starting inside the done notice takes the pill back over", (t) => {
  const { shown, loader, tick } = fixture(t, { spinTimeout: 100, doneNotice: 500 })
  loader(["a.example"])
  tick(100)
  loader([])
  assert.deepEqual(shown.at(-1), ["Stories updated", "done"])
  loader(["c.example"])
  assert.deepEqual(shown.at(-1), ["Loading 1 source: c.example", "loading"], "already shown, so no new wait")
  tick(1000)
  assert.equal(shown.at(-1)[1], "loading", "the stale done notice never hides an active reload")
  loader([])
  tick(500)
  assert.deepEqual(shown.at(-1), ["Ready", "ready"])
})

test("the spin timeout is measured from the start of a pass, not from each change", (t) => {
  const { shown, loader, tick } = fixture(t, { spinTimeout: 100 })
  loader(["a.example"])
  tick(60)
  loader(["a.example", "b.example"])
  tick(40)
  assert.equal(shown.length, 1)
})

test("unbinding drops pending timers and the subscription", (t) => {
  const { shown, loader, unbind, tick } = fixture(t, { spinTimeout: 100 })
  loader(["a.example"])
  unbind()
  tick(1000)
  assert.deepEqual(shown, [])
  assert.throws(() => loader([]), "the handler is gone")
})
