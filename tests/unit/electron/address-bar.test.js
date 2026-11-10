const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const { parseHTML } = require("linkedom")

const compiled = ts.transpileModule(
  fs.readFileSync(path.resolve(__dirname, "../../../apps/electron/src/browser/AddressBar.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText
const { AddressBar } = (() => {
  const exports = {}
  Function("exports", "require", compiled)(exports, (name) => { throw Error(`unexpected import ${name}`) })
  return exports
})()

/** The field with a user at it: focus, typing and Enter arrive as the events a browser sends. */
function addressBar() {
  const { document, Event } = parseHTML("<html><body><input id='urlfield'><div id='url_error'></div></body></html>")
  const input = document.getElementById("urlfield")
  let focused = null
  Object.defineProperty(document, "activeElement", { get: () => focused })
  input.select = () => {}
  input.focus = () => { focused = input; input.dispatchEvent(new Event("focus")) }
  input.blur = () => { if (focused !== input) return; focused = null; input.dispatchEvent(new Event("blur")) }
  const navigated = []
  const bar = new AddressBar(input, document.getElementById("url_error"), {
    navigate: async (url) => { navigated.push(url) },
    showMenu: async () => null,
    errorChanged() {}
  })
  return {
    bar, input, navigated,
    type(text) { input.focus(); input.value = text; input.dispatchEvent(new Event("input")) },
    enter() { input.dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter" })) }
  }
}

test("an address being typed outlasts what its tab does meanwhile, and is what Enter opens", () => {
  const { bar, input, navigated, type, enter } = addressBar()
  bar.show("tab", "about:blank")
  assert.equal(input.value, "about:blank")

  // A restored page arriving, a redirect, a script moving the page on.
  type("https://typed.example/")
  bar.show("tab", "https://restored.example/")
  bar.show("tab", "https://restored.example/next")
  assert.equal(input.value, "https://typed.example/")
  enter()
  assert.deepEqual(navigated, ["https://typed.example/"])

  // Sent, the field is the tab's again.
  bar.show("tab", "https://typed.example/")
  bar.show("tab", "https://typed.example/redirected")
  assert.equal(input.value, "https://typed.example/redirected")
})

test("a focused field nobody typed in follows its tab; unfocused, it drops what was typed", () => {
  const { bar, input, type } = addressBar()
  bar.show("tab", "https://one.example/")
  input.focus()
  bar.show("tab", "https://two.example/")
  assert.equal(input.value, "https://two.example/")

  type("half an addr")
  bar.show("tab", "https://two.example/")
  assert.equal(input.value, "half an addr", "the same state again leaves the edit alone")
  input.blur()
  bar.show("tab", "https://two.example/")
  assert.equal(input.value, "https://two.example/")
})

test("another tab's address replaces one being typed, and that tab is followed from then on", () => {
  const { bar, input, type } = addressBar()
  bar.show("first", "https://one.example/")
  type("half an addr")
  bar.show("second", "https://two.example/")
  assert.equal(input.value, "https://two.example/")
  bar.show("second", "https://two.example/next")
  assert.equal(input.value, "https://two.example/next")

  // With no tab at all the field keeps what it has.
  bar.show(null, "")
  assert.equal(input.value, "https://two.example/next")
  bar.show("second", "https://two.example/next")
  assert.equal(input.value, "https://two.example/next")
})
