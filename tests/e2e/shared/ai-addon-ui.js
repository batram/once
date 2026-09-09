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
  // Opening explains and summarizes in one go: the answer is in view, the
  // entities and the summary wait behind closed disclosures.
  await expect(tray.locator("strong", { hasText: "ExampleApp is software" })).toBeVisible()
  // The `has` locator must be page-rooted; it is matched relative to each details element.
  const entities = tray.locator("details", { has: page.locator("summary", { hasText: "Key entities" }) })
  const summary = tray.locator("details", { has: page.locator("summary", { hasText: "Summary" }) })
  await expect(entities).not.toHaveAttribute("open", "")
  await expect(summary).not.toHaveAttribute("open", "")
  await expect(tray.locator("code")).toBeHidden()
  await entities.locator("summary").click()
  await expect(tray.locator("code")).toHaveText("projects")
  await expect(tray.locator("code")).toBeVisible()
  await expect(tray.getByRole("button", { name: "Summarize", exact: true })).toHaveCount(0)
  await expect(action).toHaveAttribute("aria-expanded", "true")
  await summary.locator("summary").click()
  await expect(tray).toContainText("Its qualifications are preserved")
  await expect(tray.locator("ul > li")).toHaveCount(2)
  await expect(tray.locator("ul > li").first()).toBeVisible()
  const question = tray.getByRole("textbox")
  await question.fill("Who uses it?")
  await tray.getByRole("button", { name: "Ask", exact: true }).click()
  await expect(tray).toContainText("Developers use it")
  await tray.getByRole("button", { name: "Close", exact: true }).click()
  await expect(tray).toHaveCount(0)
  await action.click()
  await expect(tray).toContainText("Developers use it")
  // The reader's choice to open the entities survives a row redraw.
  await expect(tray.locator("code")).toBeVisible()
  await row.evaluate(element => element.update_complete_story_el())
  await expect(tray).toContainText("Developers use it")
  await expect(tray.locator("code")).toBeVisible()
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
