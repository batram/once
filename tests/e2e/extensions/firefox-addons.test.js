const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")
const { Builder, By, until } = require("selenium-webdriver")
const firefox = require("selenium-webdriver/firefox")
const { ADDON_INTEGRITY } = require("../shared/addon-fixture")
const { startStoryFixture } = require("./local-source")
const {
  openExtensionPanel,
  openSettingsSection,
  reopenExtensionPanel,
  systemAccessService
} = require("./firefox-panel")

// Firefox lets no page under an extension's origin run third-party code, so
// its scripted add-ons run in a frame pointed at a hosted copy of the
// self-contained sandbox page. This test hosts that page on the local fixture
// server, names it through the real setting in the Add-ons section, and then
// runs the same fixture add-on the other suites run: the badge it computes has
// to reach the row through a sandbox frame on another origin.
test("Firefox runs a scripted add-on in a hosted sandbox page", { timeout: 120_000 }, async () => {
  const expectedAddonId = "once_sidepanel_f@zmarn.com"
  const extensionUuid = "00000000-0000-4000-8000-000000000002"
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
  const source = await startStoryFixture()
  const setValue = (element, value) => driver.executeScript(
    `arguments[0].value = arguments[1]
     arguments[0].dispatchEvent(new Event("input", { bubbles: true }))
     arguments[0].dispatchEvent(new Event("change", { bubbles: true }))`,
    element,
    value
  )
  try {
    const extensionPath = path.resolve(__dirname, "../../../apps/firefox-extension/dist/release")
    const bidi = await driver.getBidi()
    const installResult = await bidi.send({
      method: "webExtension.install",
      params: { extensionData: { type: "path", path: extensionPath } }
    })
    assert.equal(installResult.result.extension, expectedAddonId)
    await openExtensionPanel(driver, extensionUuid)

    // The Firefox-only control in the Add-ons section names the hosted page.
    const sandboxUrl = `${source.origin}/sandbox/addon-sandbox-hosted.html`
    const urlInput = await openSettingsSection(driver, "addons", '[data-testid="addon-sandbox-url"]')
    await setValue(urlInput, sandboxUrl)
    await driver.findElement(By.css('[data-testid="save-addon-sandbox-url"]')).click()
    await driver.wait(
      until.elementTextContains(
        driver.findElement(By.css("#firefox_addon_sandbox_settings .settings_status")),
        "Saved"
      ),
      5_000
    )
    const sources = await openSettingsSection(driver, "sources", '[data-testid="sources"]')
    await setValue(sources, source.source)
    await driver.findElement(By.css('[data-testid="save-sources"]')).click()

    // The URL applies when the panel mounts, as the control says.
    await reopenExtensionPanel(driver, extensionUuid)
    const editor = await openSettingsSection(driver, "addons", "#addons_area")
    await setValue(editor, JSON.stringify([{
      protocol: 1,
      id: "harness-script",
      name: "Harness Script",
      version: "1.0.0",
      script: { url: `${source.origin}/addon/main.js`, integrity: ADDON_INTEGRITY },
      contributions: [
        { kind: "action", id: "visit", label: "Visit from add-on", surfaces: ["button", "menu"], run: { message: "visit" } },
        { kind: "badge", id: "len", compute: "len" }
      ]
    }]))
    await driver.findElement(By.css('[data-testid="save-addons"]')).click()
    await driver.wait(
      until.elementTextIs(
        driver.findElement(By.css('[data-settings-target="addons"] .settings_section_summary')),
        "1 of 1 enabled"
      ),
      10_000
    )

    await driver.findElement(By.css('[data-testid="stories-menu"]')).click()
    await driver.findElement(By.css("#searchfield")).clear()
    await driver.findElement(By.css('[data-testid="reload-stories"]')).click()
    const alpha = await driver.wait(
      until.elementLocated(By.css(`#stories story-item[data-href="${source.urls.alpha}"]`)),
      20_000
    )
    const title = await alpha.findElement(By.css("a.title")).getText()
    const badge = await driver.wait(
      until.elementLocated(By.css('#stories story-item .addon_badge[data-addon-badge="len"]')),
      20_000
    )
    await driver.wait(until.elementTextIs(badge, `len ${title.length}`), 20_000)
    assert.equal(
      (await alpha.findElements(By.css('.addon_btn[data-story-element="addon:harness-script/visit"]'))).length,
      1
    )
    const frame = await driver.findElement(By.css("iframe[data-addon-sandbox]"))
    assert.equal(await frame.getAttribute("src"), sandboxUrl)
    assert.ok(
      source.requests.includes("/sandbox/addon-sandbox-hosted.html"),
      `the hosted page was fetched: ${source.requests.join(", ")}`
    )
  } finally {
    await driver.quit()
    await source.close()
  }
})
