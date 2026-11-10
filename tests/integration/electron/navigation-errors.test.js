const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const Module = require("node:module")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const electronStub = { dialog: {} }
const visits = []
const originalLoad = Module._load
const originalTs = Module._extensions[".ts"]
const originalHtml = Module._extensions[".html"]
const originalCss = Module._extensions[".css"]

Module._load = function load(request, parent, isMain) {
  if (request === "electron") return electronStub
  if (request === "../BrowserHistory") return { browserHistory: () => ({ record: async (visit) => { visits.push(visit.url) } }) }
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
const { TabEvents } = require(path.join(root, "apps/electron/src/browser/TabEvents.ts"))

test.after(() => {
  Module._load = originalLoad
  if (originalTs) Module._extensions[".ts"] = originalTs
  else delete Module._extensions[".ts"]
  if (originalHtml) Module._extensions[".html"] = originalHtml
  else delete Module._extensions[".html"]
  if (originalCss) Module._extensions[".css"] = originalCss
  else delete Module._extensions[".css"]
})

function entry(failure, committedUrl = "") {
  const loaded = []
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getURL: () => committedUrl,
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
  assert.equal(tab.loadError, "ERR_NAME_NOT_RESOLVED (-105)")
})

// Chromium's media document (a video opened on its own) commits but never
// finishes loading, so Electron rejects the load although the player is up.
test("a load that stopped unfinished on the page it asked for shows that page", async () => {
  const unfinished = Object.assign(
    new Error("ERR_FAILED (-2) loading 'https://example.com/clip.mp4'"),
    { code: "ERR_FAILED", errno: -2 }
  )
  const tab = entry(unfinished, "https://example.com/clip.mp4")

  navigationErrors().load(tab, "https://example.com/clip.mp4")
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(tab.loaded, ["https://example.com/clip.mp4"])
  assert.equal(tab.loadError, null)
})

test("a load that stopped unfinished before any page committed still reports", async () => {
  const unfinished = Object.assign(
    new Error("ERR_FAILED (-2) loading 'https://example.com/'"),
    { code: "ERR_FAILED", errno: -2 }
  )
  const tab = entry(unfinished)

  navigationErrors().load(tab, "https://example.com/")
  await new Promise((resolve) => setImmediate(resolve))

  assert.match(tab.loaded[1], /^once-error:\/\//)
  assert.equal(tab.loadError, "ERR_FAILED (-2)")
})

/** A tab wired to the real navigation events, its webContents driven by hand. */
function liveTab() {
  const tab = entry()
  let committed = "", loadingMain = false
  Object.assign(tab.view.webContents, {
    getURL: () => committed,
    getTitle: () => "",
    isLoadingMainFrame: () => loadingMain,
    setWindowOpenHandler() {},
    setAudioMuted() {},
    navigationHistory: { getAllEntries: () => [], getActiveIndex: () => 0 }
  })
  Object.assign(tab, { sync: { navSeq: 0, openedAt: 0, navigatedAt: 0, selectedAt: 0, activityAt: 0 }, historySnapshot: null })
  const errors = navigationErrors()
  const access = { ownerFor: () => undefined, notify() {} }
  new TabEvents(errors, { showContentsMenu() {} }, { ...access, applyRedirects: (url) => url, normalizeUrl: (url) => url },
    { ...access, createTab: async () => "new", createWindow: async () => {}, setFullscreen() {} },
    { ...access, finalizeClosedTab() {} }).bind(tab)
  const emit = (name, ...args) => tab.view.webContents.emit(name, ...args)
  return {
    tab,
    /** What loadURL does at once: the load is asked for and its navigation starts. */
    load(url) {
      errors.load(tab, url)
      loadingMain = true
      emit("did-start-loading")
      emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url })
    },
    /** The page arrives and, being small, is done loading at once. */
    commit(url) {
      committed = url
      emit("did-navigate", {}, url, 200)
      emit("did-finish-load")
    },
    stop() {
      loadingMain = false
      emit("did-stop-loading")
    }
  }
}

// Recorded from the app: a page about to commit cannot be cancelled, so it
// still arrives after the tab was sent elsewhere.
test("a page that commits after the tab was sent on does not take the address back", () => {
  const { tab, load, commit, stop } = liveTab()
  load("https://example.com/story")
  load("https://example.com/comments")
  assert.equal(tab.displayedUrl, "https://example.com/comments")

  commit("https://example.com/story")
  assert.equal(tab.displayedUrl, "https://example.com/comments", "the overtaken page is not what the tab is heading for")
  commit("https://example.com/comments")
  stop()
  assert.equal(tab.displayedUrl, "https://example.com/comments")
  assert.deepEqual(visits.splice(0), ["https://example.com/comments"], "history has the page that stayed, once")
})

test("a navigation that ends without a page leaves the tab on the one that did commit", () => {
  const { tab, load, commit, stop } = liveTab()
  load("https://example.com/story")
  load("https://example.com/file.zip")
  commit("https://example.com/story")
  // The download never commits; the load just stops.
  stop()
  assert.equal(tab.displayedUrl, "https://example.com/story")
  visits.length = 0

  // Nothing is under way any more, so a page arriving on its own shows again.
  commit("https://example.com/next")
  assert.equal(tab.displayedUrl, "https://example.com/next")
})
