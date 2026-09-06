const { test, expect } = require("@playwright/test")
const { addonPackageManifest } = require("../shared/addon-fixture")
const { launchApp, closeApp, startPageServer, openSettingsSection } = require("./electron-harness")

test("reviewed updates preserve state and reject a broken replacement package", async () => {
  let version = "1.0.0"
  let broken = false
  const server = await startPageServer({ addonManifest: () => ({
    ...addonPackageManifest(), version,
    ...(broken ? { script: { url: "main.js", integrity: `sha256-${"A".repeat(43)}=` } } : {}),
    settings: { type: "object", properties: { suffix: { type: "string", default: "" } } }
  }) })
  const { electronApp, userData, window } = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
  try {
    const input = await openSettingsSection(window, "addons", "#addon_url_input")
    await input.fill(`${server.origin}/addon/once-addon.json`)
    await window.getByTestId("install-addon").click()
    const confirm = window.getByTestId("confirm-addon")
    await expect(confirm).toBeVisible()
    await expect(window.locator("#addon_installed fieldset")).toHaveCount(0)
    await confirm.click()
    await expect(window.locator("#addon_installed")).toContainText("1.0.0")
    const editor = window.locator("#addons_area")
    await expect(editor).toHaveValue(/1\.0\.0/)
    await require("../shared/addon-settings-ui").addonAdvanced(window)
    await editor.evaluate(area => {
      const entries = JSON.parse(area.value)
      entries[0].storage = { count: 7 }
      entries[0].options = { suffix: "!" }
      area.value = JSON.stringify(entries)
    })
    await window.getByTestId("save-addons").click()
    await expect(editor).toHaveValue(/"count": 7/)
    version = "2.0.0"
    await require("../shared/addon-settings-ui").addonOverview(window)
    await window.getByTestId("update-addons").click()
    await expect(confirm).toBeVisible()
    await expect(editor).toHaveValue(/1\.0\.0/)
    await confirm.click()
    await expect(window.locator("#addon_installed")).toContainText("2.0.0")
    await expect(editor).toHaveValue(/2\.0\.0/)
    const updated = JSON.parse(await editor.inputValue())[0]
    expect(updated.storage).toEqual({ count: 7 })
    expect(updated.options).toEqual({ suffix: "!" })
    await window.locator("#addon_install_settings").screenshot({ path: test.info().outputPath("addon-management.png") })
    version = "3.0.0"
    broken = true
    await window.getByTestId("update-addons").click()
    await expect(confirm).toBeVisible()
    await confirm.click()
    await expect(window.locator("#addon_previews [role=status]")).toContainText("integrity")
    await expect(editor).toHaveValue(/2\.0\.0/)
    const installed = window.locator("#addon_installed")
    await require("../shared/addon-settings-ui").addonSettings(window, "harness-package")
    await installed.getByRole("button", { name: "Disable", exact: true }).click()
    await expect(installed).toContainText("Disabled")
    await installed.getByRole("button", { name: "Remove", exact: true }).click()
    await expect(installed.locator("fieldset")).toHaveCount(0)
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})
