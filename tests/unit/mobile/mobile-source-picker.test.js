const test = require("node:test")
const assert = require("node:assert/strict")

async function loadPicker() {
  return import("../../../apps/mobile/src/mobileSourcePicker.ts")
}

function createSurface(results = []) {
  const calls = []
  const listeners = new Map()
  const removals = []
  return {
    calls,
    listeners,
    removals,
    available: true,
    async setVisible(value) { calls.push(["visible", value]) },
    async evaluateJavaScript(script) {
      calls.push(["evaluate", script])
      return script.includes("__oncePickerResult===undefined") && results.length
        ? results.shift()
        : null
    },
    async addListener(event, listener) {
      listeners.set(event, listener)
      return () => {
        removals.push(event)
        listeners.delete(event)
      }
    }
  }
}

function encodedPickerResult(conf) {
  return JSON.stringify(JSON.stringify(conf === null ? null : JSON.stringify(conf)))
}

async function installedPicker(options = {}) {
  const { MobileSourcePicker } = await loadPicker()
  const surface = options.surface || createSurface()
  const activations = []
  const opened = []
  const picker = new MobileSourcePicker({
    surface,
    openBrowserUrl: (url) => opened.push(url),
    activateSurface: () => activations.push("reading"),
    loadInjection: async () => "picker injection",
    delay: async () => undefined,
    pollAttempts: 2,
    ...options
  })
  await picker.install()
  return { picker, surface, activations, opened }
}

test("runs the injected picker contract and sanitizes its result", async () => {
  const conf = {
    stories: { all: true, sel: ".story" },
    link: { component: "href", sel: "a" },
    title: { component: "innerText", processors: ["trim"], sel: "h2" }
  }
  const surface = createSurface([encodedPickerResult(conf)])
  const context = await installedPicker({ surface })
  surface.listeners.get("navigationCommitted")({
    navigationId: 1,
    url: "https://example.test/news"
  })

  const source = await context.picker.pick("")

  assert.equal(source.url, "https://example.test/news")
  assert.equal(source.collector, "geny")
  assert.deepEqual(source.select, conf)
  assert.deepEqual(context.activations, ["reading"])
  assert.deepEqual(surface.calls[0], ["visible", true])
  assert.equal(surface.calls[1][1], "picker injection")
  assert.match(surface.calls[2][1], /__onceSourcePicker/)
})

test("waits for requested navigation and cleans both listeners on success", async () => {
  const surface = createSurface([encodedPickerResult(null)])
  const context = await installedPicker({
    surface,
    openBrowserUrl(url) {
      context.opened.push(url)
      surface.listeners.get("navigationCommitted")({ navigationId: 2, url })
      surface.listeners.get("navigationFinished")({ navigationId: 2, url })
    }
  })

  assert.equal(await context.picker.pick("https://example.test/new"), null)
  assert.deepEqual(context.opened, ["https://example.test/new"])
  assert.deepEqual(
    [...surface.removals].sort(),
    ["navigationFailed", "navigationFinished"]
  )
})

test("reports navigation failure and cleans both navigation listeners", async () => {
  const surface = createSurface()
  const context = await installedPicker({
    surface,
    openBrowserUrl(url) {
      surface.listeners.get("navigationFailed")({
        navigationId: 3,
        url,
        code: 500,
        message: "offline"
      })
    }
  })

  await assert.rejects(
    context.picker.pick("https://example.test/fail"),
    /page could not be loaded: offline/
  )
  assert.deepEqual(
    [...surface.removals].sort(),
    ["navigationFailed", "navigationFinished"]
  )
})

test("times out when the injected picker never reports a result", async () => {
  const context = await installedPicker()
  context.surface.listeners.get("navigationCommitted")({
    navigationId: 1,
    url: "https://example.test/news"
  })
  await assert.rejects(context.picker.pick(""), /source picker timed out/)
})

test("rejects malformed native serialization", async () => {
  const surface = createSurface([JSON.stringify(JSON.stringify({ nope: true }))])
  const context = await installedPicker({ surface })
  surface.listeners.get("navigationCommitted")({
    navigationId: 1,
    url: "https://example.test/news"
  })
  await assert.rejects(context.picker.pick(""), /malformed result/)
})
