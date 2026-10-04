const test = require("node:test")
const assert = require("node:assert/strict")

const { ReadingSession } = require(
  "../../../packages/ui-web/dist/ReadingSession"
)

global.document = {
  body: {
    classList: {
      toggle() {}
    }
  }
}

async function loadCoordinator() {
  return import("../../../apps/mobile/src/readingSurfaceCoordinator.ts")
}

function createSurface() {
  const calls = []
  const listeners = new Map()
  return {
    calls,
    listeners,
    available: true,
    async open(options) { calls.push(["open", options]) },
    async navigate(url) { calls.push(["navigate", url]) },
    async reload() { calls.push(["reload"]) },
    async goBack() { calls.push(["goBack"]) },
    async setBounds(bounds) { calls.push(["setBounds", bounds]) },
    async setVisible(visible) { calls.push(["setVisible", visible]) },
    async showMenu() { return null },
    async showPrompt() { return null },
    async evaluateJavaScript() { return null },
    async close() { calls.push(["close"]) },
    async addListener(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    }
  }
}

function createReader() {
  return {
    setVisible() {},
    destroy() {},
    opened: [],
    closes: 0,
    async open(html) { this.opened.push(html) },
    close() { this.closes += 1 }
  }
}

function flushCoordinator() {
  return new Promise((resolve) => setImmediate(resolve))
}

test("a rejected browser open becomes a visible error and Reload retries initialization", async () => {
  const { ReadingSurfaceCoordinator } = await loadCoordinator()
  const session = new ReadingSession(), surface = createSurface()
  let attempts = 0
  surface.open = async options => {
    surface.calls.push(["open", options])
    if (++attempts === 1) throw new Error("Browser extensions did not become ready in time. Try again.")
  }
  const coordinator = new ReadingSurfaceCoordinator(session, surface, createReader(), {
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 320, height: 500 })
  })
  await coordinator.install()
  coordinator.setReadingPanelVisible(true)
  session.navigate("https://example.test/first")
  await flushCoordinator()
  assert.equal(session.snapshot().loadState, "error")
  assert.match(session.snapshot().error, /extensions did not become ready/)
  assert.equal(attempts, 1, "Publishing an error must not automatically open again")
  await coordinator.reload()
  await flushCoordinator()
  assert.equal(attempts, 2)
  assert.equal(surface.calls.at(-1)[0], "setVisible")
  surface.listeners.get("navigationStarted")({ navigationId: 1, url: "https://example.test/first" })
  surface.listeners.get("navigationFinished")({ navigationId: 1, url: "https://example.test/first" })
  assert.equal(session.snapshot().loadState, "ready")
})

test("an old initialization failure cannot overwrite a newer address", async () => {
  const { ReadingSurfaceCoordinator } = await loadCoordinator()
  const session = new ReadingSession(), surface = createSurface()
  let rejectOpen
  const open = surface.open
  surface.open = options => {
    surface.open = open
    return new Promise((resolve, reject) => { rejectOpen = reject })
  }
  const coordinator = new ReadingSurfaceCoordinator(session, surface, createReader(), {
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 320, height: 500 })
  })
  await coordinator.install()
  session.navigate("https://example.test/old")
  await flushCoordinator()
  session.navigate("https://example.test/new")
  rejectOpen(new Error("Old initialization failed"))
  await flushCoordinator()
  assert.equal(session.snapshot().currentUrl, "https://example.test/new")
  assert.equal(session.snapshot().loadState, "loading")
  assert.equal(session.snapshot().error, null)
  assert.equal(surface.calls.find(([name]) => name === "open")[1].url, "https://example.test/new")
})

test("late native events cannot replace a newer address before its page start", async () => {
  const { ReadingSurfaceCoordinator } = await loadCoordinator()
  const session = new ReadingSession(), surface = createSurface()
  const coordinator = new ReadingSurfaceCoordinator(session, surface, createReader(), {
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 320, height: 500 })
  })
  await coordinator.install()
  session.navigate("https://example.test/old")
  await flushCoordinator()
  surface.listeners.get("navigationStarted")({ navigationId: 1, url: "https://example.test/old" })
  await flushCoordinator()
  session.navigate("https://example.test/latest")
  for (const name of ["historyChanged", "navigationCommitted", "navigationFinished", "navigationStarted"]) {
    surface.listeners.get(name)({ navigationId: 1, url: "https://example.test/old", canGoBack: true })
  }
  await flushCoordinator()
  assert.equal(session.snapshot().currentUrl, "https://example.test/latest")
  assert.equal(session.snapshot().loadState, "loading")
  assert.deepEqual(surface.calls.filter(([name]) => name === "navigate"), [["navigate", "https://example.test/latest"]])
  surface.listeners.get("navigationStarted")({ navigationId: 2, url: "https://example.test/latest" })
  surface.listeners.get("navigationCommitted")({ navigationId: 2, url: "https://example.test/redirected" })
  surface.listeners.get("navigationFinished")({ navigationId: 2, url: "https://example.test/redirected" })
  assert.equal(session.snapshot().currentUrl, "https://example.test/redirected")
  assert.equal(session.snapshot().loadState, "ready")
})

test("reading surface coordinator owns bounds and native visibility", async () => {
  const { ReadingSurfaceCoordinator } = await loadCoordinator()
  const session = new ReadingSession()
  const surface = createSurface()
  const reader = createReader()
  const content = {
    getBoundingClientRect: () => ({
      x: 4,
      y: 52,
      width: 312,
      height: 480
    })
  }
  const coordinator = new ReadingSurfaceCoordinator(
    session,
    surface,
    reader,
    content
  )

  coordinator.setReadingPanelVisible(true)
  session.navigate("https://example.test/first")
  await flushCoordinator()

  assert.deepEqual(surface.calls.find(([name]) => name === "open"), [
    "open",
    {
      url: "https://example.test/first",
      bounds: { x: 4, y: 52, width: 312, height: 480 },
      visible: false
    }
  ])
  assert.deepEqual(surface.calls.at(-1), ["setVisible", true])

  coordinator.setMenuOpen(true)
  await flushCoordinator()
  assert.deepEqual(surface.calls.at(-1), ["setVisible", false])
  coordinator.setOverlayOpen(true)
  coordinator.setMenuOpen(false)
  await flushCoordinator()
  assert.deepEqual(surface.calls.at(-1), ["setVisible", false])
  session.navigate("https://example.test/second")
  await flushCoordinator()
  assert.deepEqual(surface.calls.at(-1), ["setVisible", false])
  coordinator.setDialogOpen(true)
  coordinator.setOverlayOpen(false)
  await flushCoordinator()
  assert.deepEqual(surface.calls.at(-1), ["setVisible", false])
  coordinator.setDialogOpen(false)
  await flushCoordinator()
  assert.deepEqual(surface.calls.at(-1), ["setVisible", true])
})

test("reading surface coordinator rejects stale reader documents", async () => {
  const { ReadingSurfaceCoordinator } = await loadCoordinator()
  const session = new ReadingSession()
  const surface = createSurface()
  const reader = createReader()
  const loads = []
  const loader = {
    load(url, acceptDocument) {
      return new Promise((resolve) => {
        loads.push({ url, acceptDocument, resolve })
      })
    }
  }
  new ReadingSurfaceCoordinator(
    session,
    surface,
    reader,
    { getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1 }) },
    loader
  )

  session.navigate("https://example.test/old")
  session.setMode("reader")
  await flushCoordinator()
  session.navigate("https://example.test/new")
  session.setMode("reader")
  await flushCoordinator()

  await loads[0].acceptDocument("<p>old</p>", loads[0].url)
  loads[0].resolve()
  await flushCoordinator()
  assert.deepEqual(reader.opened, [])

  await loads[1].acceptDocument("<p>new</p>", loads[1].url)
  loads[1].resolve()
  await flushCoordinator()
  assert.deepEqual(reader.opened, ["<p>new</p>"])
  assert.equal(session.snapshot().loadState, "ready")
})

test("forward history reaches the surface and native edge swipes reach the shell only while a page shows", async () => {
  const { ReadingSurfaceCoordinator } = await loadCoordinator()
  const session = new ReadingSession(), surface = createSurface()
  surface.goForward = async () => { surface.calls.push(["goForward"]) }
  const coordinator = new ReadingSurfaceCoordinator(session, surface, createReader(), {
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 320, height: 500 })
  })
  const swipes = []
  coordinator.onEdgeSwipe((direction) => swipes.push(direction))
  await coordinator.install()

  // No page open yet: the shell's own gesture covers the DOM, not this path.
  surface.listeners.get("edgeSwipe")({ direction: "back" })
  assert.deepEqual(swipes, [])

  coordinator.setReadingPanelVisible(true)
  session.navigate("https://example.test/page")
  await flushCoordinator()
  surface.listeners.get("navigationStarted")({ navigationId: 1, url: "https://example.test/page" })
  surface.listeners.get("historyChanged")({
    navigationId: 1, url: "https://example.test/page", canGoBack: true, canGoForward: true
  })
  assert.equal(session.snapshot().canGoForward, true)

  surface.listeners.get("edgeSwipe")({ direction: "back" })
  surface.listeners.get("edgeSwipe")({ direction: "forward" })
  assert.deepEqual(swipes, ["back", "forward"])

  await coordinator.goForward()
  assert.ok(surface.calls.some(([name]) => name === "goForward"))

  coordinator.setReadingPanelVisible(false)
  await flushCoordinator()
  surface.listeners.get("edgeSwipe")({ direction: "back" })
  assert.deepEqual(swipes, ["back", "forward"])
})

test("a failed navigation hides the native page and retry navigates to the failed address", async () => {
  const { ReadingSurfaceCoordinator } = await loadCoordinator()
  const session = new ReadingSession(), surface = createSurface()
  const coordinator = new ReadingSurfaceCoordinator(session, surface, createReader(), {
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 320, height: 500 })
  })
  await coordinator.install()
  coordinator.setReadingPanelVisible(true)
  session.navigate("https://example.test/previous")
  await flushCoordinator()
  surface.listeners.get("navigationStarted")({ navigationId: 1, url: "https://example.test/previous" })
  surface.listeners.get("navigationFinished")({ navigationId: 1, url: "https://example.test/previous" })
  session.navigate("https://example.test/failing")
  await flushCoordinator()
  surface.listeners.get("navigationStarted")({ navigationId: 2, url: "https://example.test/failing" })
  surface.listeners.get("navigationFailed")({ navigationId: 2, url: "https://example.test/failing", message: "The Internet connection appears to be offline." })
  await flushCoordinator()
  assert.equal(session.snapshot().loadState, "error")
  assert.equal(coordinator.isBrowserReady(), false)
  assert.deepEqual(surface.calls.at(-1), ["setVisible", false])
  coordinator.setMenuOpen(true)
  coordinator.setMenuOpen(false)
  await flushCoordinator()
  assert.deepEqual(surface.calls.at(-1), ["setVisible", false], "closing a menu must not cover the error with the old native page")
  await coordinator.reload()
  await flushCoordinator()
  assert.equal(session.snapshot().loadState, "loading")
  assert.equal(session.snapshot().error, null)
  assert.deepEqual(surface.calls.filter(([name]) => name === "navigate").at(-1), ["navigate", "https://example.test/failing"])
  assert.equal(surface.calls.some(([name]) => name === "reload"), false)
  surface.listeners.get("navigationStarted")({ navigationId: 3, url: "https://example.test/failing" })
  surface.listeners.get("navigationFailed")({ navigationId: 2, url: "https://example.test/failing", message: "Old failure" })
  assert.equal(session.snapshot().loadState, "loading")
  surface.listeners.get("navigationFinished")({ navigationId: 3, url: "http://example.test/redirected/" })
  await flushCoordinator()
  assert.equal(session.snapshot().loadState, "ready")
  assert.equal(session.snapshot().currentUrl, "http://example.test/redirected/")
  assert.deepEqual(surface.calls.at(-1), ["setVisible", true])
})

function createContent() {
  return { getBoundingClientRect: () => ({ x: 0, y: 0, width: 320, height: 500 }) }
}

test("an emptied tab hides its page instead of retiring it, and the next address navigates", async () => {
  const { ReadingSurfaceCoordinator } = await loadCoordinator()
  const session = new ReadingSession(true), surface = createSurface()
  const coordinator = new ReadingSurfaceCoordinator(session, surface, createReader(), createContent())
  await coordinator.install()
  coordinator.setReadingPanelVisible(true)
  session.navigate("https://example.test/first")
  await flushCoordinator()
  session.close()
  await flushCoordinator()
  assert.equal(surface.calls.some(([name]) => name === "close"), false)
  assert.deepEqual(surface.calls.at(-1), ["setVisible", false])
  session.navigate("https://example.test/first")
  await flushCoordinator()
  assert.deepEqual(surface.calls.filter(([name]) => name === "open" || name === "navigate").map(([name]) => name), ["open", "navigate"])
  coordinator.dispose(true)
  await flushCoordinator()
  assert.deepEqual(surface.calls.at(-1), ["close"])
})

test("an adopted popup accepts its replayed, redirected navigation", async () => {
  const { ReadingSurfaceCoordinator } = await loadCoordinator()
  const session = new ReadingSession(true), surface = createSurface()
  const coordinator = new ReadingSurfaceCoordinator(session, surface, createReader(), createContent())
  const finished = []
  coordinator.onNavigationFinished(event => finished.push(event.url))
  await coordinator.install()
  session.navigate("https://example.test/popup")
  coordinator.adopt("https://example.test/popup")
  surface.open = async options => {
    surface.calls.push(["open", options])
    surface.listeners.get("navigationStarted")({ navigationId: 7, url: "https://example.test/landing" })
    surface.listeners.get("navigationCommitted")({ navigationId: 7, url: "https://example.test/landing" })
    surface.listeners.get("navigationFinished")({ navigationId: 7, url: "https://example.test/landing", title: "Landing" })
  }
  await flushCoordinator()
  assert.equal(session.snapshot().loadState, "ready")
  assert.equal(session.snapshot().currentUrl, "https://example.test/landing")
  assert.equal(coordinator.isBrowserReady(), true)
  assert.deepEqual(finished, ["https://example.test/landing"])
  assert.equal(surface.calls.some(([name]) => name === "navigate"), false)
})

test("a late finish of the previous page neither loads nor labels the new address", async () => {
  const { ReadingSurfaceCoordinator } = await loadCoordinator()
  const session = new ReadingSession(true), surface = createSurface()
  const coordinator = new ReadingSurfaceCoordinator(session, surface, createReader(), createContent())
  const finished = []
  coordinator.onNavigationFinished(event => finished.push(event.url))
  await coordinator.install()
  session.navigate("https://example.test/old")
  await flushCoordinator()
  surface.listeners.get("navigationStarted")({ navigationId: 1, url: "https://example.test/old" })
  session.navigate("https://example.test/new")
  surface.listeners.get("navigationFinished")({ navigationId: 1, url: "https://example.test/old", title: "Old" })
  assert.deepEqual(finished, [])
  assert.equal(session.snapshot().loadState, "loading")
})
