const { test, expect } = require("./electron-harness")
const { launchApp, closeApp, openSettingsSection } = require("./electron-harness")
const { addonOverview, addonSettings, addonImport } = require("../shared/addon-settings-ui")

// The harness starts every profile with the shipped packages switched off;
// this spec turns them back on to see a first start the way a user does.
const BUNDLED = { env: { ONCE_ELECTRON_DISABLE_BUNDLED_ADDONS: "0" } }
const ID = "what-wait-who-why"

test("the shipped AI addon is installed on first start, stays removed across restarts, and installs again from the import page", async () => {
  const first = await launchApp(BUNDLED)
  const { userData } = first
  let { electronApp, window } = first
  try {
    await openSettingsSection(window, "addons")
    const row = () => window.locator(`.addon_list_row[data-addon-id="${ID}"]`)
    await expect(row()).toBeVisible()
    await expect(row().locator(".addon_list_meta")).toContainText("Bundled with Once")
    await addonSettings(window, ID)
    const installed = window.locator(`#addon_installed [data-addon-id="${ID}"]`)
    // "idle" is the sandbox with the script loaded and verified, waiting for a story.
    await expect(installed.locator(".addon_runtime_status")).toHaveText("idle")
    await expect(window.getByTestId(`addon-option-${ID}-provider`)).toBeVisible()
    await installed.getByRole("button", { name: "Remove", exact: true }).click()
    await expect(window.locator("#addon_overview")).toBeVisible()
    await expect(row()).toHaveCount(0)
    await expect(window.locator("#addon_overview")).toContainText("No addons yet")

    // A removed package is remembered as such, not offered again on the next start.
    await closeApp(electronApp, userData, { keepUserData: true })
    ;({ electronApp, window } = await launchApp({ ...BUNDLED, userData }))
    await openSettingsSection(window, "addons")
    await expect(window.locator("#addon_overview")).toContainText("No addons yet")
    await expect(row()).toHaveCount(0)

    await addonImport(window)
    const again = window.getByTestId(`install-bundled-${ID}`)
    await expect(again).toBeVisible()
    await again.click()
    await expect(window.getByTestId("confirm-addon")).toHaveText("Confirm install")
    await window.getByTestId("confirm-addon").click()
    await expect(again).toBeHidden()
    await addonOverview(window)
    await expect(row()).toBeVisible()
    await expect(row().locator(".addon_list_meta")).toContainText("Bundled with Once")
  } finally { await closeApp(electronApp, userData) }
})
