const { test, expect } = require("@playwright/test")
const {
  STORY_TITLE,
  startGenyFixture
} = require("../shared/geny-fixture")
const {
  closeApp,
  launchApp,
  seedLocalSource
} = require("./electron-harness")

test("Electron genymatch extracts innerText from fetched HTML", async () => {
  const fixture = await startGenyFixture()
  const { electronApp, userData, window } = await launchApp({
    env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" }
  })
  try {
    await seedLocalSource(window, fixture.source, fixture.storyUrl)
    const buildInfo = await window.evaluate(() =>
      window.onceElectron.app.getBuildInfo()
    )
    const story = window.locator(
      `#stories story-item[data-href="${fixture.storyUrl}"]`
    )
    await expect(story.locator("a.title")).toHaveText(STORY_TITLE)
    await expect(story).toContainText("TypeScript")

    const collectorUserAgent = fixture.userAgents[0]
    expect(collectorUserAgent).toContain(" Chrome/")
    expect(collectorUserAgent).toContain(" Safari/")
    expect(collectorUserAgent).not.toContain(" Electron/")
    expect(
      collectorUserAgent.endsWith(` (Once/${buildInfo.version})`)
    ).toBe(true)
  } finally {
    await closeApp(electronApp, userData)
    await fixture.close()
  }
})
