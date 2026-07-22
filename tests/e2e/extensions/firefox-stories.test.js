const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")
const { Builder, By, until } = require("selenium-webdriver")
const firefox = require("selenium-webdriver/firefox")
const { startStoryFixture } = require("./local-source")
const storyFixture = require("../shared/story-fixture")
const {
  openExtensionPanel,
  reopenExtensionPanel,
  systemAccessService
} = require("./firefox-panel")

function storySelector(href) {
  return `#stories story-item[data-href="${href}"]`
}

async function waitForClass(driver, selector, className, present = true) {
  await driver.wait(async () => {
    const value = await driver.findElement(By.css(selector)).getAttribute("class")
    const hasClass = value.split(/\s+/).includes(className)
    return hasClass === present
  }, 10_000, `${selector} did not ${present ? "gain" : "lose"} .${className}`)
}

async function openNewTab(driver, panelHandle, action, expectedUrl) {
  const existingHandles = new Set(await driver.getAllWindowHandles())
  await action()
  const openedHandle = await driver.wait(async () => {
    const handles = await driver.getAllWindowHandles()
    return handles.find((handle) => !existingHandles.has(handle)) || false
  }, 10_000, `no tab opened for ${expectedUrl}`)
  await driver.switchTo().window(openedHandle)
  await driver.wait(until.urlIs(expectedUrl), 10_000)
  await driver.close()
  await driver.switchTo().window(panelHandle)
}

test(
  "Firefox extension story interactions persist on a local-only fixture",
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
    const source = await startStoryFixture()
    try {
      const extensionPath = path.resolve(
        __dirname,
        "../../../apps/firefox-extension/dist"
      )
      const bidi = await driver.getBidi()
      const installResult = await bidi.send({
        method: "webExtension.install",
        params: { extensionData: { type: "path", path: extensionPath } }
      })
      assert.equal(installResult.result.extension, expectedAddonId)

      let panelHandle = await openExtensionPanel(driver, extensionUuid)

      await driver
        .findElement(By.css('[data-testid="settings-menu"]'))
        .click()
      const animation = await driver.findElement(By.css("#anim_checkbox"))
      if (await animation.isSelected()) await animation.click()
      const sources = await driver.findElement(
        By.css('[data-testid="sources"]')
      )
      await sources.clear()
      await sources.sendKeys(source.source)
      await driver
        .findElement(By.css('[data-testid="save-sources"]'))
        .click()
      await driver
        .findElement(By.css('[data-testid="stories-menu"] > .heading'))
        .click()
      await driver.findElement(By.css("#searchfield")).clear()
      await driver.wait(
        until.elementLocated(By.css(storySelector(source.urls.alpha))),
        15_000
      )

      const alphaSelector = storySelector(source.urls.alpha)
      const alphaTitle = await driver.findElement(
        By.css(`${alphaSelector} ${storyFixture.SELECTORS.title}`)
      )
      await driver.actions().move({ origin: alphaTitle }).perform()
      assert.equal(
        await driver.executeScript(
          "return document.querySelector('#hover_url')"
        ),
        null,
        "Firefox must rely on its native hovered-link display"
      )
      await openNewTab(
        driver,
        panelHandle,
        () => alphaTitle.click(),
        source.urls.alpha
      )
      await waitForClass(driver, alphaSelector, "read")

      const gammaSelector = storySelector(source.urls.gamma)
      const gammaReadButton = By.css(
        `${gammaSelector} ${storyFixture.SELECTORS.readBtn}`
      )
      await driver.findElement(gammaReadButton).click()
      await waitForClass(driver, gammaSelector, "skipped")
      await driver.findElement(gammaReadButton).click()
      await waitForClass(driver, gammaSelector, "skipped", false)
      await waitForClass(driver, gammaSelector, "read", false)

      const deltaSelector = storySelector(source.urls.delta)
      await driver
        .findElement(
          By.css(`${deltaSelector} ${storyFixture.SELECTORS.starBtn}`)
        )
        .click()
      await waitForClass(driver, deltaSelector, "stared")

      panelHandle = await reopenExtensionPanel(driver, extensionUuid)
      await driver.wait(
        until.elementLocated(
          By.css('[data-testid="stories-menu"] > .heading')
        ),
        15_000
      )
      await driver
        .findElement(By.css('[data-testid="stories-menu"] > .heading'))
        .click()
      await driver.findElement(By.css("#searchfield")).clear()
      await driver
        .findElement(By.css('[data-testid="reload-stories"]'))
        .click()
      await driver.wait(
        until.elementLocated(By.css(deltaSelector)),
        15_000
      )
      await waitForClass(driver, deltaSelector, "stared")

      const betaSelector = storySelector(source.urls.beta)
      await openNewTab(
        driver,
        panelHandle,
        () =>
          driver
            .findElement(By.css(`${betaSelector} .info a.comment_url`))
            .click(),
        source.urls.betaComments
      )

      await driver
        .findElement(
          By.css(`${deltaSelector} ${storyFixture.SELECTORS.filterBtn}`)
        )
        .click()
      const filterInput = await driver.findElement(
        By.css(`${deltaSelector} ${storyFixture.SELECTORS.filterBtn} input`)
      )
      await driver.executeScript(
        `arguments[0].value = arguments[1]
         const event = new Event("keyup", { bubbles: true })
         Object.defineProperty(event, "key", { value: "Enter" })
         Object.defineProperty(event, "keyCode", { value: 13 })
         Object.defineProperty(event, "which", { value: 13 })
         arguments[0].dispatchEvent(event)`,
        filterInput,
        storyFixture.FILTER_TOKEN
      )
      const confirmButton = await driver.wait(
        until.elementLocated(By.css('[data-testid="confirm-accept"]')),
        10_000
      )
      await confirmButton.click()
      await waitForClass(driver, deltaSelector, "filtered")
    } catch (error) {
      error.message += `\nFixture requests: ${JSON.stringify(source.requests)}`
      throw error
    } finally {
      await driver.quit()
      await source.close()
    }
  }
)
