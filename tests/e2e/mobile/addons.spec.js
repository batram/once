const { test, expect } = require("@playwright/test")
const { ADDON_INTEGRITY } = require("../shared/addon-fixture")
const { testServerUrl } = require("./helpers/mobile-app")
const { openSettingsSection } = require("./helpers/settings")
const { seedFixtureStories } = require("./helpers/stories")
const { installAiAddon, exerciseAiTray } = require("../shared/ai-addon-ui")

test("mobile imports a local addon ZIP through the file input", async ({ page }) => {
  const story = await seedFixtureStories(page)
  await openSettingsSection(page, "addons")
  await require("../shared/local-addon-fixture").importZip(page)
  await page.getByTestId("stories-menu").click()
  await expect(story.locator('[data-addon-badge="ready"]')).toHaveText("Local package ready")
})

test("AI addon opens an interactive tray on a touch story row", async ({ page }) => {
  const story = await seedFixtureStories(page)
  const origin = new URL(await testServerUrl(page, "/")).origin
  await openSettingsSection(page, "addons")
  await installAiAddon(page, origin)
  await page.getByTestId("stories-menu").click()
  await openSettingsSection(page, "theme")
  await page.locator('[id="story-button-mobile-addon:what-wait-who-why/explain"]').check()
  await page.getByTestId("stories-menu").click()
  await exerciseAiTray(page, story)
})

// The sandbox page is a static asset beside the app here, loaded in a
// sandboxed frame; the same fixture script the Electron suite runs has to
// compute a badge and answer a button on the mobile row.
test("a scripted add-on runs in the mobile sandbox", async ({ page }) => {
  const story = await seedFixtureStories(page)
  const scriptUrl = await testServerUrl(page, "/fixtures/addon/main.js")
  const manifest = [{
    protocol: 1,
    id: "harness-script",
    name: "Harness Script",
    version: "1.0.0",
    script: { url: scriptUrl, integrity: ADDON_INTEGRITY },
    contributions: [
      { kind: "action", id: "visit", label: "Visit from add-on", surfaces: ["button", "menu"], run: { message: "visit" } },
      { kind: "badge", id: "len", compute: "len" }
    ]
  }]

  await openSettingsSection(page, "addons")
  await require("../shared/addon-settings-ui").addonAdvanced(page)
  await page.getByTestId("addons").fill(JSON.stringify(manifest))
  const save = page.getByTestId("save-addons")
  await save.click()
  await expect(save).toBeEnabled()
  await expect(page.locator('[data-settings-target="addons"] .settings_section_summary'))
    .toHaveText("1 of 1 enabled")

  await page.getByTestId("stories-menu").click()
  const title = await story.locator("a.title").innerText()
  await expect(story.locator('.addon_badge[data-addon-badge="len"]')).toHaveText(`len ${title.length}`)
  // Mobile rows keep their buttons out of sight; the action reaches the row
  // through the ⋮ menu instead.
  await expect(story.locator('.addon_btn[data-story-element="addon:harness-script/visit"]')).toHaveCount(1)
  await story.getByTestId("story-menu-button").click()
  const menu = page.getByTestId("story-menu")
  await expect(menu).toBeVisible()
  await expect(menu).toContainText("Visit from add-on")
  await page.getByTestId("story-menu-backdrop").click({ position: { x: 5, y: 5 } })
  expect(await page.locator("iframe[data-addon-sandbox]").count()).toBe(1)
})
