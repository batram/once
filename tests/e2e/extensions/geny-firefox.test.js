const test = require("node:test")
const assert = require("node:assert/strict")
const { By, until } = require("selenium-webdriver")
const {
  STORY_TITLE,
  startGenyFixture
} = require("../shared/geny-fixture")
const {
  openExtensionPanel,
  openSettingsSection,
  startFirefox,
  budget
} = require("./firefox-panel")

test(
  "Firefox genymatch extracts innerText from fetched HTML",
  { timeout: 90_000 },
  async () => {
    const extensionUuid = "00000000-0000-4000-8000-000000000001"
    const fixture = await startGenyFixture()
    let driver
    try {
      driver = await startFirefox(extensionUuid)
      await openExtensionPanel(driver, extensionUuid)

      const sources = await openSettingsSection(
        driver,
        "sources",
        '[data-testid="sources"]'
      )
      await sources.clear()
      await sources.sendKeys(fixture.source)
      await driver.findElement(
        By.css('[data-testid="save-sources"]')
      ).click()
      await driver.findElement(
        By.css('[data-testid="stories-menu"]')
      ).click()
      await driver.findElement(By.css("#searchfield")).clear()

      const story = await driver.wait(
        until.elementLocated(
          By.css(`story-item[data-href="${fixture.storyUrl}"]`)
        ),
        budget(15_000)
      )
      assert.equal(await story.findElement(By.css("a.title")).getText(), STORY_TITLE)
      assert.match(await story.getText(), /TypeScript/)
    } catch (error) {
      // A Firefox that never started, or died, has no page text to add.
      const bodyText = await driver?.findElement(By.css("body")).getText().catch(() => "(unavailable)")
      error.message +=
        `\nFixture requests: ${JSON.stringify(fixture.requests)}` +
        `\nPage text: ${bodyText}`
      throw error
    } finally {
      try {
        await driver?.quit()
      } finally {
        await fixture.close()
      }
    }
  }
)
