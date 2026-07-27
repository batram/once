const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const {
  createFallbackInAppBrowserSurface,
  isEmbeddableUrl
} = require("../../../packages/platform-mobile/dist/InAppBrowserSurface")
const {
  normalizeReadingUrl
} = require("../../../packages/platform-mobile/dist/ReadingUrl")

test("embedded browser URL policy only accepts http and https", () => {
  assert.equal(isEmbeddableUrl("https://example.test/story"), true)
  assert.equal(isEmbeddableUrl("http://example.test/story"), true)
  assert.equal(isEmbeddableUrl("javascript:alert(1)"), false)
  assert.equal(isEmbeddableUrl("mailto:test@example.test"), false)
  assert.equal(isEmbeddableUrl("not a URL"), false)
})

test("reading address normalization accepts only HTTP and HTTPS URLs", () => {
  assert.deepEqual(
    normalizeReadingUrl(" example.test/story "),
    { ok: true, url: "https://example.test/story" }
  )
  assert.deepEqual(
    normalizeReadingUrl("http://example.test/story"),
    { ok: true, url: "http://example.test/story" }
  )
  assert.equal(normalizeReadingUrl("").ok, false)
  assert.equal(normalizeReadingUrl("file:///tmp/story").ok, false)
  assert.equal(normalizeReadingUrl("not a url").ok, false)
})

test("browser fallback preserves event order while opening externally", async () => {
  const opened = []
  const events = []
  const surface = createFallbackInAppBrowserSurface(async (url) => opened.push(url))
  for (const event of [
    "navigationStarted",
    "navigationCommitted",
    "historyChanged",
    "navigationFinished"
  ]) {
    await surface.addListener(event, (payload) => events.push([event, payload]))
  }

  await surface.open({
    url: "https://example.test/story",
    bounds: { x: 0, y: 0, width: 320, height: 480 },
    visible: true
  })

  assert.deepEqual(opened, ["https://example.test/story"])
  assert.deepEqual(events.map(([event]) => event), [
    "navigationStarted",
    "navigationCommitted",
    "historyChanged",
    "navigationFinished"
  ])
  assert.ok(events.every(([, payload]) => payload.navigationId === 1))
  assert.equal(surface.available, false)
  await assert.rejects(
    surface.navigate("file:///private/story"),
    /only supports http and https/
  )
})

test("mobile reading atomically opens a visible native surface", () => {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    "../../../apps/mobile/src/readingController.ts"
  ), "utf8")
  const requestHandler = source.slice(
    source.indexOf("document.body.addEventListener(READING_REQUEST"),
    source.indexOf("document.addEventListener(\"once-panel-changed\"")
  )

  assert.ok(requestHandler.indexOf('this.activePanel = "reading"') >= 0)
  assert.ok(requestHandler.indexOf("this.session.open(") >= 0)
  assert.ok(requestHandler.indexOf('Menu.open_panel("reading")') >= 0)
  assert.ok(
    requestHandler.indexOf('this.activePanel = "reading"') <
    requestHandler.indexOf("this.session.open(")
  )
  assert.ok(
    requestHandler.indexOf('Menu.open_panel("reading")') <
    requestHandler.indexOf("this.session.open(")
  )
})

test("native embedded browsers use a bounded foreground sibling", () => {
  const root = path.resolve(__dirname, "../../..")
  const android = fs.readFileSync(path.join(
    root,
    "apps/mobile/android/app/src/main/java/com/zmarn/once/InAppBrowserSurfacePlugin.java"
  ), "utf8")
  const ios = fs.readFileSync(path.join(
    root,
    "apps/mobile/ios/App/App/AppDelegate.swift"
  ), "utf8")

  assert.match(android, /parent\.addView\(\s*refreshSurface,\s*shellIndex \+ 1,/)
  assert.doesNotMatch(android, /shell\.setBackgroundColor\(Color\.TRANSPARENT\)/)
  assert.match(ios, /insertSubview\(view, aboveSubview: shell\)/)
  assert.doesNotMatch(ios, /insertSubview\(view, belowSubview: shell\)/)
})

test("native embedded browsers support pull-to-refresh", () => {
  const root = path.resolve(__dirname, "../../..")
  const android = fs.readFileSync(path.join(
    root,
    "apps/mobile/android/app/src/main/java/com/zmarn/once/InAppBrowserSurfacePlugin.java"
  ), "utf8")
  const ios = fs.readFileSync(path.join(
    root,
    "apps/mobile/ios/App/App/AppDelegate.swift"
  ), "utf8")

  assert.match(android, /new SwipeRefreshLayout/)
  assert.match(android, /setOnRefreshListener\(surface::reload\)/)
  assert.match(android, /refreshSurface\.setRefreshing\(false\)/)
  assert.match(ios, /view\.scrollView\.refreshControl = refreshControl/)
  assert.match(ios, /@objc private func refreshBrowser/)
  assert.match(ios, /refreshControl\?\.endRefreshing\(\)/)
})

test("visual inspection installs the current app before preserving its state", () => {
  const runner = fs.readFileSync(path.resolve(
    __dirname,
    "../../e2e/mobile/run-mobile-e2e.js"
  ), "utf8")

  assert.match(runner, /function installVisualApp\(\)/)
  assert.match(runner, /"install",\s*"-r",\s*app/)
  assert.match(runner, /"simctl",\s*"install"/)
  const start = runner.slice(runner.indexOf("async function start()"))
  assert.ok(
    start.indexOf("installVisualApp()") <
    start.indexOf("startTestServer({")
  )
})
