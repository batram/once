const { test, expect } = require("@playwright/test")
const { gotoMobileApp } = require("./helpers/mobile-app")
const { openSettingsSection } = require("./helpers/settings")
const { seedFixtureStories } = require("./helpers/stories")

// A finger from the screen edge, as the shell's touch handlers see it. Playwright's
// touchscreen only taps, so the touch sequence is dispatched directly.
async function edgeSwipe(page, direction) {
  await page.evaluate((direction) => {
    const width = window.innerWidth
    const y = 300
    const startX = direction === "back" ? 6 : width - 6
    const travel = [30, 70, 110, 150].map(x => direction === "back" ? x : width - x)
    const target = document.elementFromPoint(startX, y) || document.body
    const fire = (type, x) => {
      const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y })
      target.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === "touchend" ? [] : [touch],
        changedTouches: [touch]
      }))
    }
    fire("touchstart", startX)
    for (const x of travel) fire("touchmove", x)
    fire("touchend", travel[travel.length - 1])
  }, direction)
}

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
