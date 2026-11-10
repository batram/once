const test = require("node:test")
const assert = require("node:assert/strict")
const { By, until } = require("selenium-webdriver")
const { startLocalSource } = require("./local-source")
const {
  openExtensionPanel,
  openSettingsSection,
  reopenExtensionPanel,
  startFirefox,
  budget
} = require("./firefox-panel")

test("installed Firefox extension loads, collects, persists settings, and opens a story", { timeout: 90_000 }, async () => {
  const extensionUuid = "00000000-0000-4000-8000-000000000001"
  const source = await startLocalSource()
  let driver
  try {
    driver = await startFirefox(extensionUuid)
    await openExtensionPanel(driver, extensionUuid)
    // A sidepanel cannot cycle tabs, focus an address bar or own a second
    // pane, so those shortcuts must not be offered at all. The one key that
    // does reach it from a page is the sidebar command, which only Firefox can
    // rebind — listed, but read-only.
    await openSettingsSection(driver, "keyboard", '[data-testid="keyboard-shortcuts"]')
    const shortcuts = await driver.findElement(
      By.css('[data-testid="keyboard-shortcuts"]')
    )
    for (const group of ["browser", "panes"]) {
      assert.equal(
        (await shortcuts.findElements(By.css(`[data-group="${group}"]`))).length,
        0,
        `the ${group} shortcuts cannot work in a sidepanel`
      )
    }
    assert.equal(
      (await shortcuts.findElements(By.css('[data-group="stories"]'))).length,
      1
    )
    const managedChords = await Promise.all(
      (await shortcuts.findElements(
        By.css('[data-group="browser-managed"] .keybinding_managed_chord')
      )).map((chord) => chord.getText())
    )
    assert.deepEqual(managedChords, ["Ctrl+Shift+Y", "Alt+Shift+C"])
    // Firefox refuses about:addons from tabs.create, so the address is offered
    // to copy rather than to open.
    assert.equal(
      await driver.findElement(
        By.css('[data-testid="keybinding-managed-url"]')
      ).getText(),
      "about:addons"
    )
    assert.equal(
      (await driver.findElements(
        By.css('[data-testid="keybinding-managed-open"]')
      )).length,
      0
    )
    assert.equal(
      (await driver.findElements(
        By.css('[data-testid="keybinding-managed-copy"]')
      )).length,
      2
    )

    let sources = await openSettingsSection(
      driver,
      "sources",
      '[data-testid="sources"]'
    )
    await sources.clear()
    await sources.sendKeys(source.source)
    await driver.findElement(By.css('[data-testid="save-sources"]')).click()
    await driver.findElement(By.css('[data-testid="stories-menu"]')).click()
    await driver.findElement(By.css("#searchfield")).clear()
    try {
      await driver.wait(until.elementLocated(By.xpath('//story-item[contains(., "Extension smoke story")]')), budget(15_000))
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
    const persistedSources = JSON.parse(await sources.getAttribute("value"))
    assert.equal(persistedSources.sources.length, 1)
    assert.equal(persistedSources.sources[0].url, `${source.origin}/feed.json`)
    assert.equal(persistedSources.sources[0].collector, "jsonselect")
    await driver.findElement(By.css('[data-testid="stories-menu"]')).click()
    await driver.findElement(By.css("#searchfield")).clear()
    await driver.findElement(By.css('[data-testid="reload-stories"]')).click()
    const restoredStory = await driver.wait(until.elementLocated(By.xpath('//story-item[contains(., "Extension smoke story")]')), budget(15_000))
    const existingHandles = new Set(await driver.getAllWindowHandles())
    await restoredStory.findElement(By.css("a.title")).click()
    const openedHandle = await driver.wait(async () => {
      const handles = await driver.getAllWindowHandles()
      return handles.find((handle) => !existingHandles.has(handle)) || false
    }, budget(10_000))
    await driver.switchTo().window(openedHandle)
    await driver.wait(until.urlIs(`${source.origin}/story`), budget(10_000))
  } finally {
    try {
      await driver?.quit()
    } finally {
      await source.close()
    }
  }
})
