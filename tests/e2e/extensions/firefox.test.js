const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")
const { Builder, By, until } = require("selenium-webdriver")
const firefox = require("selenium-webdriver/firefox")
const { startLocalSource } = require("./local-source")
const {
  openExtensionPanel,
  openSettingsSection,
  reopenExtensionPanel,
  systemAccessService
} = require("./firefox-panel")

test("installed Firefox extension loads, collects, persists settings, and opens a story", { timeout: 90_000 }, async () => {
  const expectedAddonId = "once_sidepanel_f@zmarn.com"
  const extensionUuid = "00000000-0000-4000-8000-000000000001"
  const options = new firefox.Options()
    .addArguments("-no-remote")
    .setPreference("extensions.webextensions.uuids", JSON.stringify({ [expectedAddonId]: extensionUuid }))
    .enableBidi()
  if (process.platform !== "win32") options.addArguments("-headless")
  const driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .setFirefoxService(systemAccessService())
    .build()
  const source = await startLocalSource()
  try {
    const extensionPath = path.resolve(__dirname, "../../../apps/firefox-extension/dist/release")
    const bidi = await driver.getBidi()
    const installResult = await bidi.send({
      method: "webExtension.install",
      params: { extensionData: { type: "path", path: extensionPath } }
    })
    assert.equal(installResult.result.extension, expectedAddonId)

    await openExtensionPanel(driver, extensionUuid)
    let sources = await openSettingsSection(
      driver,
      "sources",
      '[data-testid="sources"]'
    )
    await sources.clear()
    await sources.sendKeys(source.source)
    await driver.findElement(By.css('[data-testid="save-sources"]')).click()
    await driver.findElement(By.css('[data-testid="stories-menu"] > .heading')).click()
    await driver.findElement(By.css("#searchfield")).clear()
    try {
      await driver.wait(until.elementLocated(By.xpath('//story-item[contains(., "Extension smoke story")]')), 15_000)
    } catch (error) {
      const bodyText = await driver.findElement(By.css("body")).getText()
      error.message += `\nLocal requests: ${JSON.stringify(source.requests)}\nPage text: ${bodyText}`
      throw error
    }
    await reopenExtensionPanel(driver, extensionUuid)
    sources = await openSettingsSection(
      driver,
      "sources",
      '[data-testid="sources"]'
    )
    assert.equal(await sources.getAttribute("value"), source.source)
    await driver.findElement(By.css('[data-testid="stories-menu"] > .heading')).click()
    await driver.findElement(By.css("#searchfield")).clear()
    await driver.findElement(By.css('[data-testid="reload-stories"]')).click()
    const restoredStory = await driver.wait(until.elementLocated(By.xpath('//story-item[contains(., "Extension smoke story")]')), 15_000)
    const existingHandles = new Set(await driver.getAllWindowHandles())
    await restoredStory.findElement(By.css("a.title")).click()
    const openedHandle = await driver.wait(async () => {
      const handles = await driver.getAllWindowHandles()
      return handles.find((handle) => !existingHandles.has(handle)) || false
    }, 10_000)
    await driver.switchTo().window(openedHandle)
    await driver.wait(until.urlIs(`${source.origin}/story`), 10_000)
  } finally {
    await driver.quit()
    await source.close()
  }
})
