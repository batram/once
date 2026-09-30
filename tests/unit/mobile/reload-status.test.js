const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const root = path.resolve(__dirname, "../../..")

const STORY_RELOAD_STARTED = "once:story-reload"

// The only value import is the event name, so the module loads with a stub
// in place of the ui-web package.
function loadReloadStatus() {
  const source = fs.readFileSync(
    path.join(root, "apps/mobile/src/reloadStatus.ts"),
    "utf8"
  )
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const moduleObject = { exports: {} }
  Function("exports", "module", "require", compiled)(
    moduleObject.exports, moduleObject, () => ({ STORY_RELOAD_STARTED })
  )
  return moduleObject.exports
}

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { bindReloadStatus } = loadReloadStatus()
  const handlers = new Map()
  const client = {
    subscribe(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    }
  }
  const reloadEvents = new EventTarget()
  const shown = []
  const unbind = bindReloadStatus(
    client,
    (message, state) => shown.push([message, state]),
    { ...options, reloadEvents }
  )
  const loader = (domains) => handlers.get("loaderChanged")({
    processing: domains.map((domain) => ({ domain, parserType: "rss" })),
    visible: domains.length > 0
  })
  const start = (trigger) => reloadEvents.dispatchEvent(
    new CustomEvent(STORY_RELOAD_STARTED, { detail: trigger })
  )
  return { shown, loader, start, unbind, tick: (ms) => t.mock.timers.tick(ms) }
}

test("a pull-to-refresh shows the pill at once and hands over to the sources", (t) => {
  const { shown, loader, start, tick } = fixture(t)
  start("pull")
  assert.deepEqual(shown, [["Loading stories…", "loading"]])
  loader(["a.example"])
  assert.deepEqual(shown.at(-1), ["Loading 1 source: a.example", "loading"])
  loader([])
  assert.deepEqual(shown.at(-1), ["Stories updated", "done"])
  tick(1500)
  assert.deepEqual(shown.at(-1), ["Ready", "ready"])
})

test("a pull that finds nothing to load still settles the pill", (t) => {
  const { shown, loader, start, tick } = fixture(t)
  start("pull")
  loader([])
  assert.deepEqual(shown.at(-1), ["Stories updated", "done"])
  tick(1500)
  assert.deepEqual(shown.at(-1), ["Ready", "ready"])
})

test("a quick button reload never reaches the status pill", (t) => {
  const { shown, loader, start, tick } = fixture(t)
  start("button")
  loader(["a.example"])
  tick(2999)
  loader([])
  tick(10000)
  assert.deepEqual(shown, [])
})

test("a slow button reload reports its sources after the reveal delay, then confirms and hides", (t) => {
  const { shown, loader, start, tick } = fixture(t)
  start("button")
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
  const { shown, loader, tick } = fixture(t, { revealDelay: 100, doneNotice: 500 })
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

test("the reveal delay is measured from the start of a pass, not from each change", (t) => {
  const { shown, loader, tick } = fixture(t, { revealDelay: 100 })
  loader(["a.example"])
  tick(60)
  loader(["a.example", "b.example"])
  tick(40)
  assert.equal(shown.length, 1)
})

test("unbinding drops pending timers and the subscription", (t) => {
  const { shown, loader, start, unbind, tick } = fixture(t, { revealDelay: 100 })
  loader(["a.example"])
  unbind()
  tick(1000)
  start("pull")
  assert.deepEqual(shown, [])
  assert.throws(() => loader([]), "the handler is gone")
})
