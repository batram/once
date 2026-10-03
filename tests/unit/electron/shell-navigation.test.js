const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const source = fs.readFileSync(path.resolve(__dirname,
  "../../../apps/electron/src/browser/WindowLifecycle.ts"), "utf8")
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const moduleStub = { exports: {} }
Function("exports", "require", compiled)(moduleStub.exports, name => {
  if (name === "@once/platform-electron/bridge") return { ELECTRON_IPC: {} }
  throw new Error(`Unexpected import: ${name}`)
})
const { WindowLifecycle } = moduleStub.exports

test("shell rejects foreign same-window navigation and redirects", () => {
  const shellEntry = "file:///app/main_window/index.html?channel=dev"
  const lifecycle = new WindowLifecycle({}, {}, shellEntry)
  const contents = new EventEmitter()
  contents.setWindowOpenHandler = () => {}
  const window = new EventEmitter()
  window.webContents = contents
  lifecycle.bind({ window })

  for (const kind of ["will-navigate", "will-redirect"]) {
    for (const url of ["https://example.test/", "file:///app/other.html",
      "file:///app/main_window/index.html?channel=release", "about:blank"]) {
      let prevented = false
      contents.emit(kind, { preventDefault() { prevented = true } }, url)
      assert.equal(prevented, true, `${kind}: ${url}`)
    }
    let prevented = false
    contents.emit(kind, { preventDefault() { prevented = true } }, `${shellEntry}#settings`)
    assert.equal(prevented, false, "same-document fragment remains allowed")
  }

  assert.equal(lifecycle.isShellDocument("https://example.test/"), false)
  assert.equal(lifecycle.isShellDocument(shellEntry), true)
})
