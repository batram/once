const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")
const fs = require("node:fs/promises")
const os = require("node:os")
const { Builder, By, until } = require("selenium-webdriver")
const firefox = require("selenium-webdriver/firefox")
const { ADDON_INTEGRITY } = require("../shared/addon-fixture")
const { startStoryFixture } = require("./local-source")
const {
  openExtensionPanel,
  openSettingsSection,
  reopenExtensionPanel,
  systemAccessService,
  budget,
  logBrowserVersion
} = require("./firefox-panel")

// A fresh Firefox install runs scripts in its packaged opaque-origin sandbox,
// without configuring a URL or serving any sandbox resources from the fixture.
test("Firefox runs scripted add-ons in its packaged sandbox without setup", { timeout: 120_000 }, async () => {
  const localDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "once-firefox-zip-"))
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
  await logBrowserVersion(driver)
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

    const sandboxUrl = `moz-extension://${extensionUuid}/static/addon-sandbox.html`
    assert.equal((await driver.findElements(By.css('[data-testid="addon-sandbox-url"]'))).length, 0)
    // Old installations may still have a hosted URL saved. It must never be used.
    await driver.executeAsyncScript(`
      browser.storage.local.set({ addonSandboxUrl: arguments[0] }).then(arguments[1])
    `, `${source.origin}/obsolete-sandbox.html`)
    const sources = await openSettingsSection(driver, "sources", '[data-testid="sources"]')
    await setValue(sources, source.source)
    await driver.findElement(By.css('[data-testid="save-sources"]')).click()

    // Source configuration survives reopening the panel.
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
      budget(10_000)
    )

    await driver.findElement(By.css('[data-testid="stories-menu"]')).click()
    await driver.findElement(By.css("#searchfield")).clear()
    await driver.findElement(By.css('[data-testid="reload-stories"]')).click()
    const alpha = await driver.wait(
      until.elementLocated(By.css(`#stories story-item[data-href="${source.urls.alpha}"]`)),
      budget(20_000)
    )
    const title = await alpha.findElement(By.css("a.title")).getText()
    const badge = await driver.wait(
      until.elementLocated(By.css('#stories story-item .addon_badge[data-addon-badge="len"]')),
      budget(20_000)
    )
    await driver.wait(until.elementTextIs(badge, `len ${title.length}`), budget(20_000))
    assert.equal(
      (await alpha.findElements(By.css('.addon_btn[data-story-element="addon:harness-script/visit"]'))).length,
      1
    )
    const frame = await driver.findElement(By.css("iframe[data-addon-sandbox]"))
    assert.equal(await frame.getAttribute("src"), sandboxUrl)
    assert.equal(await frame.getAttribute("sandbox"), "allow-scripts")
    assert.equal(source.requests.some(url => url.includes("sandbox")), false)
    assert.equal(await driver.executeScript(`
      return document.querySelector('iframe[data-addon-sandbox]').contentDocument === null
    `), true, "the sandbox must be cross-origin even though its page is packaged")
    await driver.switchTo().frame(frame)
    try {
      const isolation = await driver.executeAsyncScript(`
        const url = arguments[0], done = arguments[1]
        let parentDenied = false, storageDenied = false
        try { void parent.document.body } catch { parentDenied = true }
        try { void localStorage.length } catch { storageDenied = true }
        fetch(url).then(
          () => done({ parentDenied, storageDenied, networkDenied: false }),
          () => done({ parentDenied, storageDenied, networkDenied: true,
            extensionApis: typeof browser !== "undefined" && !!browser.runtime })
        )
      `, `${source.origin}/sandbox-network-probe`)
      assert.deepEqual(isolation, {
        parentDenied: true, storageDenied: true, networkDenied: true, extensionApis: false
      })
    } finally {
      await driver.switchTo().defaultContent()
    }
    assert.equal(source.requests.includes("/sandbox-network-probe"), false)
    const ai = require("../shared/ai-addon-fixture")
    const aiEditor = await openSettingsSection(driver, "addons", "#addons_area")
    await setValue(aiEditor, JSON.stringify([ai.manifest(source.origin)]))
    await driver.findElement(By.css('[data-testid="save-addons"]')).click()
    const token = await driver.wait(until.elementLocated(By.css('[data-testid="addon-option-what-wait-who-why-compatibleToken"]')), 10000)
    await driver.findElement(By.css("#settings_section_back")).click()
    await driver.wait(until.elementLocated(By.css('.addon_list_row[data-addon-id="what-wait-who-why"]')), 10000).click()
    await token.sendKeys("fixture-token")
    await driver.executeScript("arguments[0].parentElement.querySelector('button').click()", token)
    // Saving options re-renders the settings control; poll its current node.
    await driver.wait(() => driver.executeScript(`
      return document.querySelector('[data-testid="addon-option-what-wait-who-why-compatibleToken"]')
        ?.parentElement.textContent.includes("Token saved on this device") ?? false
    `), 10000)
    await driver.findElement(By.css('[data-testid="stories-menu"]')).click()
    const aiButton = await driver.wait(until.elementLocated(By.css('[data-addon-tray-button="addon:what-wait-who-why/assistant"]')), 10000)
    await aiButton.click()
    // The tray is replaced as responses arrive; read the live DOM atomically.
    await driver.wait(() => driver.executeScript(`
      return document.querySelector("#stories .addon_tray")
        ?.textContent.includes("ExampleApp is software") ?? false
    `), 20000)
    // A second panel must not overwrite the owner's conversation with null.
    const secondUrl = `moz-extension://${extensionUuid}/static/sidepanel.html?once-e2e=1&second=1`
    const second = await driver.executeAsyncScript("browser.tabs.create({url: arguments[0], active: false}).then(arguments[1])", secondUrl)
    await driver.wait(() => driver.executeScript(`
      return browser.extension.getViews().some(w => w.location.href.includes('second=1') && w.document.body.dataset.onceReady === 'true')
    `), 15000)
    await driver.findElement(By.css('#stories [data-testid="addon-tray-continue"]')).click()
    const conversationState = () => driver.executeScript(`
      const w = browser.extension.getViews().find(w => w.location.pathname.endsWith('/addon-conversation.html'))
      return { messages: w?.document.querySelector('.addon_conversation_messages')?.textContent,
        notice: w?.document.querySelector('.addon_conversation_notice')?.textContent,
        selected: document.querySelector('#selected_container story-item')?.dataset.href }
    `)
    await driver.wait(async () => (await conversationState()).messages?.includes("ExampleApp is software"), 10000)
    await driver.wait(async () => (await conversationState()).selected === source.urls.alpha, 10000)
    // Remove the unrelated panel: it must not disconnect the owner's tab.
    await driver.executeAsyncScript("browser.tabs.remove(arguments[0]).then(arguments[1])", second.id)
    await driver.findElement(By.css('#stories .addon_tray button[aria-label="Close"]')).click()
    assert.ok((await conversationState()).messages.includes("ExampleApp is software"))
    assert.equal((await conversationState()).notice, "")
    await openSettingsSection(driver, "addons", "#addon_url_input")
    const localZip = path.join(localDirectory, "local-package.zip")
    await fs.writeFile(localZip, await require("../shared/local-addon-fixture").zipFile())
    await driver.findElement(By.css('[data-testid="addon-zip-file"]')).sendKeys(localZip)
    await driver.wait(until.elementLocated(By.css('[data-testid="confirm-addon"]')), 10000)
    await driver.findElement(By.css('[data-testid="confirm-addon"]')).click()
    await driver.findElement(By.css('[data-testid="stories-menu"]')).click()
    await driver.wait(() => driver.executeScript(`
      return document.querySelector('#stories [data-addon-badge="ready"]')
        ?.textContent === "Local package ready"
    `), 10000)
  } finally {
    await driver.quit()
    await source.close()
    await fs.rm(localDirectory, { recursive: true, force: true })
  }
})
