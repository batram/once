const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const Module = require("node:module")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const electronStub = {
  dialog: { showMessageBoxSync: () => 1 }
}
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
const { TabOwnership } = require(path.join(
  root,
  "apps/electron/src/browser/TabOwnership.ts"
))
const { TabEvents } = require(path.join(
  root,
  "apps/electron/src/browser/TabEvents.ts"
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

function fakeWindow(id) {
  const events = new EventEmitter()
  const children = []
  const sent = []
  return Object.assign(events, {
    webContents: Object.assign(new EventEmitter(), {
      id,
      mainFrame: {},
      isDestroyed: () => false,
      send: (...args) => sent.push(args)
    }),
    contentView: {
      addChildView: (view) => children.push(view),
      removeChildView: (view) => children.splice(children.indexOf(view), 1)
    },
    destroy() {
      this.destroyed = true
    },
    isDestroyed: () => false,
    sent,
    children
  })
}

function owner(id, tabs = []) {
  return {
    window: fakeWindow(id),
    tabs,
    activeId: null,
    backgroundColor: "#fff",
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    closing: false
  }
}

function entry(id, ownerId) {
  const contents = Object.assign(new EventEmitter(), {
    focus() {},
    isDestroyed: () => false,
    navigationHistory: {
      canGoForward: () => false
    }
  })
  return {
    id,
    ownerId,
    view: {
      webContents: contents,
      setBackgroundColor(color) {
        this.backgroundColor = color
      },
      setBounds(bounds) {
        this.bounds = bounds
      }
    },
    displayedUrl: "https://example.com",
    title: id,
    loading: false,
    audible: false,
    hasPlayedAudio: false,
    muted: false,
    loadError: null,
    errorPages: new Map()
  }
}

test("TabOwnership transfers an active tab and restores source activation", () => {
  const ownership = new TabOwnership(
    { backTargetIndex: () => -1 },
    { createBlankTab: async () => {} }
  )
  const source = owner(1)
  const target = owner(2)
  const first = entry("first", 1)
  const moving = entry("moving", 1)
  ownership.addWindow(source)
  ownership.addWindow(target)
  ownership.addTab(source, first)
  ownership.addTab(source, moving)
  ownership.activate(source, "moving")

  ownership.move(target, "moving")

  assert.deepEqual(source.tabs, ["first"])
  assert.equal(source.activeId, "first")
  assert.deepEqual(target.tabs, ["moving"])
  assert.equal(target.activeId, "moving")
  assert.equal(moving.ownerId, 2)
  assert.equal(moving.view.backgroundColor, "#fff")
})

test("TabOwnership closes an empty secondary window after its last tab", () => {
  const ownership = new TabOwnership(
    { backTargetIndex: () => -1 },
    { createBlankTab: async () => assert.fail("secondary window must close") }
  )
  const primary = owner(1)
  const secondary = owner(2)
  const closing = entry("closing", 2)
  ownership.addWindow(primary)
  ownership.addWindow(secondary)
  ownership.addTab(secondary, closing)
  ownership.activate(secondary, closing.id)

  ownership.finalizeClosed(closing)

  assert.equal(secondary.closing, true)
  assert.equal(secondary.window.destroyed, true)
})

test("TabEvents composes navigation, interaction, and lifecycle families", () => {
  const tab = entry("tab", 1)
  tab.view.webContents.setWindowOpenHandler = (handler) => {
    tab.view.webContents.windowOpenHandler = handler
  }
  const errors = {
    state: () => null,
    handleFailure() {},
    restore() {},
    collapseFailedEntry() {},
    applyTheme() {}
  }
  const ownerAccess = { ownerFor: () => undefined, notify() {} }
  const events = new TabEvents(
    errors,
    { showContentsMenu() {} },
    { ...ownerAccess, applyRedirects: (url) => url },
    {
      ...ownerAccess,
      createTab: async () => "new",
      createWindow: async () => {},
      setFullscreen() {}
    },
    { ...ownerAccess, finalizeClosedTab() {} }
  )

  events.bind(tab)

  assert.equal(tab.view.webContents.listenerCount("did-start-loading"), 1)
  assert.equal(tab.view.webContents.listenerCount("before-input-event"), 1)
  assert.equal(tab.view.webContents.listenerCount("destroyed"), 1)
  assert.equal(typeof tab.view.webContents.windowOpenHandler, "function")
})

test("TabEvents preserves the title while reloading the current URL", () => {
  const tab = entry("tab", 1)
  tab.title = "Existing title"
  tab.view.webContents.setWindowOpenHandler = () => {}
  const errors = {
    state: () => null,
    handleFailure() {},
    restore() {},
    collapseFailedEntry() {},
    applyTheme() {}
  }
  const ownerAccess = { ownerFor: () => undefined, notify() {} }
  const events = new TabEvents(
    errors,
    { showContentsMenu() {} },
    { ...ownerAccess, applyRedirects: (url) => url },
    {
      ...ownerAccess,
      createTab: async () => "new",
      createWindow: async () => {},
      setFullscreen() {}
    },
    { ...ownerAccess, finalizeClosedTab() {} }
  )
  events.bind(tab)

  tab.view.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
    url: tab.displayedUrl
  })
  assert.equal(tab.title, "Existing title")

  tab.view.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
    url: "https://example.com/next"
  })
  assert.equal(tab.title, "New tab")
})
