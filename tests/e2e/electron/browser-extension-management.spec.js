const { test, expect } = require("@playwright/test")
const { closeApp, launchApp, startPageServer } = require("./electron-harness")
const { verifySponsorBlock } = require("./sponsorblock-fixture")

test("install and manage the requested Firefox extensions through settings", async () => {
  test.skip(process.env.ONCE_TEST_AMO_EXTENSIONS !== "1", "Live Mozilla package compatibility check; set ONCE_TEST_AMO_EXTENSIONS=1")
  test.setTimeout(180000)
  const pageServer = await startPageServer()
  const { electronApp, userData, window } = await launchApp()
  const errors = []
  electronApp.process().stderr.on("data", data => errors.push(data.toString()))
  await electronApp.evaluate(({ app }) => app.on("web-contents-created", (_event, contents) => {
    contents.on("console-message", event => {
      if (event.level === "error") console.error("Extension test page:", contents.getURL(), event.message)
    })
  }))
  try {
    await window.getByTestId("settings-menu").click()
    await window.locator('[data-settings-target="extensions"]').click()
    await expect(window.getByRole("button", { name: "Install extension", exact: true })).toBeVisible()
    const inventory = () => window.evaluate(() => window.onceElectron.extensions.installed())
    await expect.poll(async () => (await inventory()).length).toBe(2)
    for (const slug of ["sponsorblock", "darkreader"]) {
      await window.getByRole("button", { name: "Install extension", exact: true }).click()
      await window.getByRole("button", { name: slug === "sponsorblock" ? "Review SponsorBlock" : "Review Dark Reader", exact: true }).click()
      await window.getByRole("button", { name: "Install reviewed extension", exact: true }).click({ timeout: 60000 })
      const preview = (await inventory()).find(item => item.id === (slug === "sponsorblock" ? "sponsorBlocker@ajay.app" : "addon@darkreader.org"))
      await expect.poll(async () => (await inventory()).find(item => item.id === preview.id)?.running).toBe(true)
      await window.evaluate(id => window.onceElectron.extensions.openOptions(id), preview.id)
      await expect.poll(async () => window.evaluate(async id => {
        const data = await window.onceElectron.extensions.storage(id)
        return Object.keys(data.local).length + Object.keys(data.sync).length
      }, preview.id), { timeout: 20000 }).toBeGreaterThan(0)
    }
    await verifySponsorBlock(electronApp, window, expect)
    // Dark Reader must actually transform a web page, not just load its background.
    const pageUrl = `${pageServer.origin}/strict-frames`
    await window.evaluate(url => window.onceElectron.tabs.create(url, true), pageUrl)
    await expect.poll(() => electronApp.evaluate(async ({ webContents }, url) => {
      const page = webContents.getAllWebContents().find(item => item.getURL() === url)
      return page ? page.executeJavaScript(`document.documentElement.getAttribute('data-darkreader-mode') === 'dynamic'
        ? Math.max(...getComputedStyle(document.body).backgroundColor.match(/[0-9]+/g).map(Number)) : 255`) : 255
    }, pageUrl), { timeout: 30000 }).toBeLessThan(80)
    const id = "addon@darkreader.org"
    await window.getByRole("button", { name: "Manage Dark Reader", exact: true }).click()
    await window.getByRole("button", { name: "Choose settings to sync", exact: true }).click()
    const selectedKey = window.locator("#extension_settings input[type=checkbox]").first()
    await expect(selectedKey).not.toBeChecked()
    await selectedKey.check()
    await window.getByRole("button", { name: "Save sync selection", exact: true }).click()
    await window.getByRole("button", { name: "Choose settings to sync", exact: true }).click()
    await expect(window.locator("#extension_settings input[type=checkbox]").first()).toBeChecked()
    await window.screenshot({ path: "artifacts/extension-support/settings-sync.png" })
    await window.locator("#settings_section_back").click()
    await window.evaluate(id => window.onceElectron.extensions.setEnabled(id, false), id)
    expect((await inventory()).find(item => item.id === id).running).toBe(false)
    await window.evaluate(id => window.onceElectron.extensions.setEnabled(id, true), id)
    expect((await inventory()).find(item => item.id === id).running).toBe(true)
    await window.evaluate(id => window.onceElectron.extensions.remove(id), id)
    expect((await inventory()).some(item => item.id === id)).toBe(false)
  } finally {
    if (test.info().status !== test.info().expectedStatus) console.log(await electronApp.evaluate(async ({ webContents }) => Promise.all(webContents.getAllWebContents()
      .filter(page => page.getURL().includes("/strict-frames"))
      .map(async page => ({ url: page.getURL(), state: await page.executeJavaScript(`({
        mode: document.documentElement.getAttribute('data-darkreader-mode'),
        styles: [...document.querySelectorAll('style')].map(style => ({classes: style.className, length: style.textContent.length})),
        background: getComputedStyle(document.body).backgroundColor
      })`) })))))
    if (test.info().status !== test.info().expectedStatus) console.log(errors.join("\n"))
    await closeApp(electronApp, userData)
    await pageServer.close()
  }
})
