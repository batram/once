const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const Module = require("node:module")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const electronStub = {}
const originalLoad = Module._load
const originalTs = Module._extensions[".ts"]
const originalHtml = Module._extensions[".html"]
const originalCss = Module._extensions[".css"]

Module._load = function load(request, parent, isMain) {
  if (request === "electron") return electronStub
  return originalLoad.call(this, request, parent, isMain)
}
Module._extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8")
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    },
    fileName: filename
  }).outputText
  module._compile(output, filename)
}
Module._extensions[".html"] = (module, filename) => {
  module.exports = filename
}
Module._extensions[".css"] = (module, filename) => {
  module.exports = filename
}

const root = path.resolve(__dirname, "../../..")
const { NavigationErrors } = require(path.join(
  root,
  "apps/electron/src/browser/NavigationErrors.ts"
))

test.after(() => {
  Module._load = originalLoad
  if (originalTs) Module._extensions[".ts"] = originalTs
  else delete Module._extensions[".ts"]
  if (originalHtml) Module._extensions[".html"] = originalHtml
  else delete Module._extensions[".html"]
  if (originalCss) Module._extensions[".css"] = originalCss
  else delete Module._extensions[".css"]
})

function entry(failure) {
  const loaded = []
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    loadURL(url) {
      loaded.push(url)
      return loaded.length === 1 && failure
        ? Promise.reject(failure)
        : Promise.resolve()
    }
  })
  return {
    id: "tab",
    ownerId: 1,
    view: { webContents: contents },
    displayedUrl: "about:blank",
    title: "tab",
    loading: false,
    loadError: null,
    loadErrorRetryable: false,
    errorPageUrl: null,
    errorPages: new Map(),
    loaded
  }
}

function navigationErrors() {
  return new NavigationErrors({
    ownerFor: () => ({ backgroundColor: "#FFFFFF" }),
    notify() {}
  })
}

// Replacing a load — switching to reader mode while the page is still
// arriving, above all — aborts the previous one. Chromium leaves the error
// description empty for some of those aborts, so Electron rejects with an
// empty `code` and only the numeric errno identifies them.
test("an aborted load without an error description shows no error page", async () => {
  const aborted = Object.assign(new Error("(-3) loading 'https://example.com/'"), {
    code: "",
    errno: -3
  })
  const tab = entry(aborted)

  navigationErrors().load(tab, "https://example.com/")
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(tab.loaded, ["https://example.com/"])
  assert.equal(tab.loadError, null)
  assert.equal(tab.errorPageUrl, null)
})

test("a named abort shows no error page either", async () => {
  const aborted = Object.assign(new Error("ERR_ABORTED (-3) loading 'https://example.com/'"), {
    code: "ERR_ABORTED",
    errno: -3
  })
  const tab = entry(aborted)

  navigationErrors().load(tab, "https://example.com/")
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(tab.loaded, ["https://example.com/"])
  assert.equal(tab.loadError, null)
})

test("a real load failure still shows its error page", async () => {
  const failure = Object.assign(
    new Error("ERR_NAME_NOT_RESOLVED (-105) loading 'https://missing.example/'"),
    { code: "ERR_NAME_NOT_RESOLVED", errno: -105 }
  )
  const tab = entry(failure)

  navigationErrors().load(tab, "https://missing.example/")
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(tab.loaded.length, 2)
  assert.match(tab.loaded[1], /^once-error:\/\//)
  assert.match(tab.loadError, /ERR_NAME_NOT_RESOLVED/)
})
