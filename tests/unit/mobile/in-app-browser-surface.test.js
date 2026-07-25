const test = require("node:test")
const assert = require("node:assert/strict")

const {
  createFallbackInAppBrowserSurface,
  isEmbeddableUrl
} = require("../../../packages/platform-mobile/dist/InAppBrowserSurface")

test("embedded browser URL policy only accepts http and https", () => {
  assert.equal(isEmbeddableUrl("https://example.test/story"), true)
  assert.equal(isEmbeddableUrl("http://example.test/story"), true)
  assert.equal(isEmbeddableUrl("javascript:alert(1)"), false)
  assert.equal(isEmbeddableUrl("mailto:test@example.test"), false)
  assert.equal(isEmbeddableUrl("not a URL"), false)
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
