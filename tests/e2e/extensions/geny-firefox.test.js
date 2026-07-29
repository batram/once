const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")
const { Builder, By, until } = require("selenium-webdriver")
const firefox = require("selenium-webdriver/firefox")
const {
  STORY_TITLE,
  startGenyFixture
} = require("../shared/geny-fixture")
const {
  openExtensionPanel,
  openSettingsSection,
  systemAccessService
} = require("./firefox-panel")

test(
  "Firefox genymatch extracts innerText from fetched HTML",
  { timeout: 90_000 },
  async () => {
    const expectedAddonId = "once_sidepanel_f@zmarn.com"
    const extensionUuid = "00000000-0000-4000-8000-000000000001"
    const options = new firefox.Options()
      .addArguments("-no-remote")
      .setPreference(
        "extensions.webextensions.uuids",
        JSON.stringify({ [expectedAddonId]: extensionUuid })
      )
      .enableBidi()
    if (process.platform !== "win32") options.addArguments("-headless")

    const driver = await new Builder()
      .forBrowser("firefox")
      .setFirefoxOptions(options)
      .setFirefoxService(systemAccessService())
      .build()
    const fixture = await startGenyFixture()
    try {
      const extensionPath = path.resolve(
        __dirname,
        "../../../apps/firefox-extension/dist/release"
      )
      const bidi = await driver.getBidi()
      const installResult = await bidi.send({
        method: "webExtension.install",
        params: { extensionData: { type: "path", path: extensionPath } }
      })
      assert.equal(installResult.result.extension, expectedAddonId)

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
        By.css('[data-testid="stories-menu"] > .heading')
      ).click()
      await driver.findElement(By.css("#searchfield")).clear()

      const story = await driver.wait(
        until.elementLocated(
          By.css(`story-item[data-href="${fixture.storyUrl}"]`)
        ),
        15_000
      )
      assert.equal(await story.findElement(By.css("a.title")).getText(), STORY_TITLE)
      assert.match(await story.getText(), /TypeScript/)
    } catch (error) {
      const bodyText = await driver.findElement(By.css("body")).getText()
      error.message +=
        `\nFixture requests: ${JSON.stringify(fixture.requests)}` +
        `\nPage text: ${bodyText}`
      throw error
    } finally {
      await driver.quit()
      await fixture.close()
    }
  }
)
