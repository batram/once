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
    opened: [],
    closes: 0,
    async open(html) { this.opened.push(html) },
    close() { this.closes += 1 }
  }
}

function flushCoordinator() {
  return new Promise((resolve) => setImmediate(resolve))
}

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
