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
    // The window's webContents id, cached on the entry: a closing window's
    // objects are gone by the time its tabs are put away.
    id,
    tabs,
    activeId: null,
    backgroundColor: "#fff",
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    closing: false,
    forwardedKeys: new Set()
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
    errorPages: new Map(),
    historySnapshot: null
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

  events.preserveTitleOnNextNavigation(tab)
  tab.view.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
    url: tab.displayedUrl
  })
  assert.equal(tab.title, "Existing title")

  tab.title = "Same URL title"
  tab.view.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
    url: tab.displayedUrl
  })
  assert.equal(tab.title, "New tab")

  tab.title = "Next page title"
  tab.view.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
    url: "https://example.com/next"
  })
  assert.equal(tab.title, "New tab")
})

function navigated(id, ownerId, url, history) {
  const tab = entry(id, ownerId)
  tab.displayedUrl = url
  tab.historySnapshot = history ?? { entries: [{ url, title: id }], index: 0 }
  return tab
}

test("TabOwnership records a closed tab with its strip position", () => {
  const ownership = new TabOwnership(
    { backTargetIndex: () => -1 },
    { createBlankTab: async () => {} }
  )
  const window = owner(1)
  ownership.addWindow(window)
  const first = navigated("first", 1, "https://example.com/one")
  const second = navigated("second", 1, "https://example.com/two")
  ownership.addTab(window, first)
  ownership.addTab(window, second)
  ownership.activate(window, "first")

  ownership.finalizeClosed(second)

  const record = ownership.closedTabs.take(window)
  assert.equal(record.url, "https://example.com/two")
  assert.equal(record.title, "second")
  assert.equal(record.index, 1, "reopening must put the tab back where it was")
  assert.equal(record.windowId, 1)
  assert.deepEqual(record.history.entries, [{ url: "https://example.com/two", title: "second" }])
  // take() consumes, so the same tab cannot be reopened twice.
  assert.equal(ownership.closedTabs.take(window), undefined)
})

test("TabOwnership does not record untouched blank tabs", () => {
  const ownership = new TabOwnership(
    { backTargetIndex: () => -1 },
    { createBlankTab: async () => {} }
  )
  const window = owner(1)
  ownership.addWindow(window)
  const kept = navigated("kept", 1, "https://example.com/kept")
  const blank = entry("blank", 1)
  blank.displayedUrl = "about:blank"
  ownership.addTab(window, kept)
  ownership.addTab(window, blank)
  ownership.activate(window, "kept")

  ownership.finalizeClosed(blank)

  // Every window opens with a blank tab; recording those would make reopen
  // mostly resurrect empty tabs.
  assert.equal(ownership.closedTabs.size, 0)
})

test("TabOwnership caps the reopen stack and prefers the asking window", () => {
  const ownership = new TabOwnership(
    { backTargetIndex: () => -1 },
    { createBlankTab: async () => {} }
  )
  const first = owner(1)
  const second = owner(2)
  ownership.addWindow(first)
  ownership.addWindow(second)
  const anchor = navigated("anchor", 1, "https://example.com/anchor")
  ownership.addTab(first, anchor)
  ownership.activate(first, "anchor")

  for (let index = 0; index < 30; index += 1) {
    const tab = navigated(`tab${index}`, 1, `https://example.com/${index}`)
    ownership.addTab(first, tab)
    ownership.finalizeClosed(tab)
  }
  assert.equal(ownership.closedTabs.size, 25)

  const otherWindowTab = navigated("other", 2, "https://example.com/other")
  ownership.addTab(second, otherWindowTab)
  ownership.activate(second, "other")
  ownership.finalizeClosed(otherWindowTab)

  // The newest record overall belongs to window 2, but window 1 gets its own.
  assert.equal(ownership.closedTabs.take(first).url, "https://example.com/29")
  assert.equal(ownership.closedTabs.take(second).url, "https://example.com/other")
})

test("TabOwnership records every tab of a closed window", () => {
  const ownership = new TabOwnership(
    { backTargetIndex: () => -1 },
    { createBlankTab: async () => {} }
  )
  const window = owner(1)
  ownership.addWindow(window)
  const first = navigated("first", 1, "https://example.com/one")
  const second = navigated("second", 1, "https://example.com/two")
  first.view.webContents.close = () => {}
  second.view.webContents.close = () => {}
  ownership.addTab(window, first)
  ownership.addTab(window, second)

  ownership.closeWindow(window)

  assert.equal(ownership.closedTabs.size, 2)
  assert.equal(ownership.closedTabs.take(window).url, "https://example.com/two")
  assert.equal(ownership.closedTabs.take(window).url, "https://example.com/one")
})

function boundTab(ownerState) {
  const tab = entry("tab", ownerState.window.webContents.id)
  tab.view.webContents.setWindowOpenHandler = () => {}
  const errors = {
    state: () => null,
    handleFailure() {},
    restore() {},
    collapseFailedEntry() {},
    applyTheme() {}
  }
  const ownerAccess = { ownerFor: () => ownerState, notify() {} }
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
  return tab
}

function pressInPage(tab, input) {
  let defaultPrevented = false
  tab.view.webContents.emit(
    "before-input-event",
    { preventDefault: () => { defaultPrevented = true } },
    { type: "keyDown", isAutoRepeat: false, control: false, alt: false,
      shift: false, meta: false, key: "", ...input }
  )
  return defaultPrevented
}

test("TabEvents forwards registered chords out of a focused page", () => {
  const window = owner(1)
  window.window.isFullScreen = () => false
  window.forwardedKeys = new Set(["Ctrl+T"])
  const tab = boundTab(window)

  const prevented = pressInPage(tab, { code: "KeyT", control: true })

  assert.equal(prevented, true, "the page must not also receive the key")
  assert.deepEqual(
    window.window.sent.at(-1),
    ["once:window:key-command", "Ctrl+T"]
  )
  // Still exactly one listener after the forwarding branch was added.
  assert.equal(tab.view.webContents.listenerCount("before-input-event"), 1)
})

test("TabEvents leaves unregistered and unmodified chords to the page", () => {
  const window = owner(1)
  window.window.isFullScreen = () => false
  // "S" is bound to next-story in the shell, but stealing a bare letter would
  // swallow ordinary typing on every site.
  window.forwardedKeys = new Set(["Ctrl+T", "S"])
  const tab = boundTab(window)

  assert.equal(pressInPage(tab, { code: "KeyS" }), false)
  assert.equal(pressInPage(tab, { code: "KeyN", control: true }), false)
  assert.equal(pressInPage(tab, { code: "KeyT", control: true, isAutoRepeat: true }), false)
  assert.equal(
    window.window.sent.some(([channel]) => channel === "once:window:key-command"),
    false
  )
})
