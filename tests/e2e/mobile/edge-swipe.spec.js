const { test, expect } = require("@playwright/test")
const { gotoMobileApp } = require("./helpers/mobile-app")
const { openSettingsSection } = require("./helpers/settings")
const { seedFixtureStories } = require("./helpers/stories")
const { edgeSwipe } = require("./helpers/gestures")

test("edge swipes walk the settings history back and forward and leave at the index", async ({ page }) => {
  await gotoMobileApp(page)
  const leftPanel = page.locator("#left_panel")
  const settingsPanel = page.locator("#settings_panel")

  await openSettingsSection(page, "swipe")
  await expect(settingsPanel).toHaveClass(/\bsettings_detail_open\b/)

  await edgeSwipe(page, "back")
  await expect(settingsPanel).not.toHaveClass(/\bsettings_detail_open\b/)
  await expect(leftPanel).toHaveAttribute("active_panel", "settings")

  await edgeSwipe(page, "forward")
  await expect(settingsPanel).toHaveClass(/\bsettings_detail_open\b/)
  await expect(page.locator(".settings_section.active")).toHaveAttribute("data-settings-section", "swipe")

  await edgeSwipe(page, "back")
  await expect(settingsPanel).not.toHaveClass(/\bsettings_detail_open\b/)
  await edgeSwipe(page, "back")
  await expect(leftPanel).toHaveAttribute("active_panel", "stories")

  // The story list is the root of the stack: its edges belong to the story
  // swipe actions, but Forward (the desktop mouse button's path) still
  // returns to Settings.
  await edgeSwipe(page, "forward")
  await expect(leftPanel).toHaveAttribute("active_panel", "stories")
  expect(await page.evaluate(() => window.__onceE2E__.handleForward())).toBe(true)
  await expect(leftPanel).toHaveAttribute("active_panel", "settings")
})

test("an edge swipe back leaves the Reading view for the story list", async ({ page }) => {
  const story = await seedFixtureStories(page)
  await story.getByTestId("story-title").click()
  const leftPanel = page.locator("#left_panel")
  await expect(leftPanel).toHaveAttribute("active_panel", "reading")
  await expect(page.getByTestId("reading-current-card")).toBeVisible()

  await edgeSwipe(page, "back")
  await expect(leftPanel).toHaveAttribute("active_panel", "stories")
})
