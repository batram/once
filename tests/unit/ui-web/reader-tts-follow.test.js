const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const root = path.resolve(__dirname, "../../..")

function loadFollow() {
  const source = fs.readFileSync(
    path.join(root, "packages/ui-web/src/reader/readerTtsFollow.ts"),
    "utf8"
  )
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const moduleObject = { exports: {} }
  Function("exports", "module", compiled)(moduleObject.exports, moduleObject)
  return moduleObject.exports.createReaderTtsFollow
}

function fakeView() {
  const listeners = new Map()
  return {
    innerHeight: 800,
    document: { documentElement: { closest: () => null } },
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type)
    },
    fire(type, props = {}) { listeners.get(type)?.({ type, target: null, ...props }) }
  }
}

function segment(top, bottom = top + 40) {
  const element = {
    scrolls: 0,
    getBoundingClientRect: () => ({ top, bottom }),
    scrollIntoView() { element.scrolls += 1 }
  }
  return element
}

test("speech follows the read segment until the user scrolls away", () => {
  const view = fakeView()
  const follow = loadFollow()(view)

  const below = segment(900)
  follow.reveal(below)
  assert.equal(below.scrolls, 1, "an off-screen segment is brought into view")

  view.fire("wheel")
  const next = segment(-600)
  follow.reveal(next)
  assert.equal(next.scrolls, 0, "a user who scrolled away keeps their place")

  const onScreen = segment(300)
  follow.reveal(onScreen)
  assert.equal(onScreen.scrolls, 0)
  const after = segment(900)
  follow.reveal(after)
  assert.equal(after.scrolls, 1, "reading back into view follows again")
})

test("touch, scroll keys and the scrollbar detach; typing in a control does not", () => {
  const view = fakeView()
  const follow = loadFollow()(view)
  const detaches = [
    ["touchmove", {}],
    ["keydown", { key: "PageDown" }],
    ["pointerdown", { target: view.document.documentElement }]
  ]
  for (const [type, props] of detaches) {
    follow.resume()
    view.fire(type, props)
    const away = segment(-400)
    follow.reveal(away)
    assert.equal(away.scrolls, 0, `${type} detaches`)
  }

  follow.resume()
  view.fire("pointerdown", { target: { closest: () => null } })
  view.fire("keydown", { key: "ArrowUp", target: { closest: () => ({}) } })
  const away = segment(-400)
  follow.reveal(away)
  assert.equal(away.scrolls, 1, "arrow keys on the rate slider do not count as scrolling")
})

test("choosing a position follows again; dispose stops listening", () => {
  const view = fakeView()
  const follow = loadFollow()(view)
  view.fire("wheel")
  follow.resume()
  const chosen = segment(-400)
  follow.reveal(chosen)
  assert.equal(chosen.scrolls, 1)

  follow.dispose()
  view.fire("wheel")
  const later = segment(-400)
  follow.reveal(later)
  assert.equal(later.scrolls, 1)
})
