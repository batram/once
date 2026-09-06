const { expect } = require("@playwright/test")
const fixture = require("./ai-addon-fixture")

async function installAiAddon(page, origin) {
  const { addonAdvanced, addonSettings } = require("./addon-settings-ui")
  await addonAdvanced(page)
  await page.getByTestId("addons").fill(JSON.stringify([fixture.manifest(origin)]))
  await page.getByTestId("save-addons").click()
  await addonSettings(page, "what-wait-who-why")
  const token = page.getByTestId("addon-option-what-wait-who-why-compatibleToken")
  await expect(token).toBeVisible()
  await token.fill("fixture-token")
  await token.locator("..").getByRole("button", { name: "Save token", exact: true }).click()
  await expect(token.locator("..").getByRole("status")).toHaveText("Token saved on this device")
  await expect(page.getByTestId("addons")).not.toHaveValue(/fixture-token/)
}

async function exerciseAiTray(page, row) {
  const action = row.locator('[data-addon-tray-button="addon:what-wait-who-why/assistant"]')
  await expect(action).toBeVisible()
  await action.click()
  const tray = row.getByTestId("addon-tray")
  await expect(tray).toContainText("ExampleApp is software", { timeout: 20000 })
  await expect(tray.getByRole("heading", { name: "Key entities" })).toBeVisible()
  await expect(tray.locator("strong", { hasText: "ExampleApp is software" })).toBeVisible()
  await expect(tray.locator("code")).toHaveText("projects")
  await expect(action).toHaveAttribute("aria-expanded", "true")
  await tray.getByRole("button", { name: "Summarize", exact: true }).click()
  await expect(tray).toContainText("Its qualifications are preserved")
  await expect(tray.locator("ul > li")).toHaveCount(2)
  const question = tray.getByRole("textbox")
  await question.fill("Who uses it?")
  await tray.getByRole("button", { name: "Ask", exact: true }).click()
  await expect(tray).toContainText("Developers use it")
  await tray.getByRole("button", { name: "Close", exact: true }).click()
  await expect(tray).toHaveCount(0)
  await action.click()
  await expect(tray).toContainText("Developers use it")
  await row.evaluate(element => element.update_complete_story_el())
  await expect(tray).toContainText("Developers use it")
  // An addon reporting its own failure, and a host one, both reach the reader as
  // an error rather than as another progress line.
  await question.fill("Break it")
  await tray.getByRole("button", { name: "Ask", exact: true }).click()
  await expect(tray.locator(".addon_tray_status--error")).toContainText("HTTP 500")
  await question.fill("Wait for me")
  await tray.getByRole("button", { name: "Ask", exact: true }).click()
  await tray.getByRole("button", { name: "Stop", exact: true }).click()
  await expect(tray.locator(".addon_tray_status--error")).toContainText("Request cancelled")
  await tray.getByRole("button", { name: "Clear conversation", exact: true }).click()
  await expect(tray.locator(".addon_tray_message")).toHaveCount(0)
}

module.exports = { installAiAddon, exerciseAiTray }
