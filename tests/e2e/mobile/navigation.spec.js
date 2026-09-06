const { test, expect } = require("@playwright/test")
const { gotoMobileApp, triggerMobileBack } = require("./helpers/mobile-app")
const { openSettingsSection } = require("./helpers/settings")
const { openStoryMenu, seedFixtureStories } = require("./helpers/stories")

test("settings menu always resets to a clean section index", async ({ page }) => {
  await gotoMobileApp(page)
  await page.getByTestId("settings-menu").click()
  const sectionCount = await page.locator(".settings_section_row").filter({ visible: true }).count()
  await page.locator("#settings_search").fill("two-stage")
  await page.locator('[data-settings-target="swipe"]').click()
  await page.getByTestId("stories-menu").click()

  await page.getByTestId("settings-menu").click()

  await expect(page.locator("#settings_panel")).not.toHaveClass(
    /\bsettings_detail_open\b/
  )
  await expect(page.locator(".settings_section.active")).toHaveCount(0)
  await expect(page.locator("#settings_search")).toHaveValue("")
  await expect(page.locator(".settings_section_row").filter({
    visible: true
  })).toHaveCount(sectionCount)
})

test("mobile back unwinds settings before restoring its previous panel", async ({ page }) => {
  await gotoMobileApp(page)
  const leftPanel = page.locator("#left_panel")

  await openSettingsSection(page, "swipe")
  await expect(page.locator("#settings_panel")).toHaveClass(
    /\bsettings_detail_open\b/
  )

  expect(await triggerMobileBack(page)).toBe(true)
  await expect(page.locator("#settings_panel")).not.toHaveClass(
    /\bsettings_detail_open\b/
  )
  await expect(leftPanel).toHaveAttribute("active_panel", "settings")

  expect(await triggerMobileBack(page)).toBe(true)
  await expect(leftPanel).toHaveAttribute("active_panel", "stories")

  await page.getByTestId("reading-menu").click()
  await page.getByTestId("settings-menu").click()
  expect(await triggerMobileBack(page)).toBe(true)
  await expect(leftPanel).toHaveAttribute("active_panel", "reading")
})

test("settings chevron back returns to the previous panel", async ({ page }) => {
  await gotoMobileApp(page)
  const leftPanel = page.locator("#left_panel")
  const settingsBack = page.locator("#settings_section_back")
  const desktopCollapse = page.locator("#settings_panel .collapsebutton")

  await page.getByTestId("settings-menu").click()
  await expect(settingsBack).toBeVisible()
  await expect(settingsBack).toHaveAttribute("aria-label", "Back")
  await expect(desktopCollapse).toBeHidden()
  await settingsBack.click()
  await expect(leftPanel).toHaveAttribute("active_panel", "stories")

  await page.getByTestId("reading-menu").click()
  await page.getByTestId("settings-menu").click()
  await settingsBack.press("Enter")
  await expect(leftPanel).toHaveAttribute("active_panel", "reading")
})

test("mobile back dismisses transient story interactions before exiting", async ({ page }) => {
  const story = await seedFixtureStories(page)
  const searchfield = page.locator("#searchfield")

  await story.locator(".hostname").click()
  await expect(searchfield).toHaveValue(/^domain:/)
  await expect(page.locator("#stories")).toBeHidden()

  expect(await triggerMobileBack(page)).toBe(true)
  await expect(searchfield).toHaveValue("")
  await expect(page.locator("#stories")).toBeVisible()
  await expect(story).toBeVisible()

  await story.getByTestId("story-menu-button").click()
  await expect(page.getByTestId("story-menu")).toBeVisible()
  expect(await triggerMobileBack(page)).toBe(true)
  await expect(page.getByTestId("story-menu")).toBeHidden()

  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-filter").click()
  await expect(page.getByTestId("text-input-dialog")).toBeVisible()
  expect(await triggerMobileBack(page)).toBe(true)
  await expect(page.getByTestId("text-input-dialog")).toBeHidden()

  await searchfield.focus()
  expect(await triggerMobileBack(page)).toBe(true)
  await expect(searchfield).not.toBeFocused()

  expect(await triggerMobileBack(page)).toBe(false)
})

test("mobile back returns an empty Reading tab to Stories", async ({ page }) => {
  await gotoMobileApp(page)
  await page.getByTestId("reading-menu").click()
  await expect(page.locator("#left_panel")).toHaveAttribute(
    "active_panel",
    "reading"
  )

  const address = page.locator("#reading_url")
  await expect(address).toHaveAttribute("placeholder", "Enter a URL")
  await expect(page.getByTestId("reading-empty")).toHaveText(
    "Open a story or enter a URL above to start reading."
  )
  await expect(page.getByTestId("reading-empty")).toBeVisible()
  await address.focus()
  expect(await triggerMobileBack(page)).toBe(true)
  await expect(address).not.toBeFocused()
  await expect(page.locator("#left_panel")).toHaveAttribute(
    "active_panel",
    "reading"
  )

  expect(await triggerMobileBack(page)).toBe(true)
  await expect(page.locator("#left_panel")).toHaveAttribute(
    "active_panel",
    "stories"
  )
})
