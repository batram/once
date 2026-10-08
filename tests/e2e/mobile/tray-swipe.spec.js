const { test, expect } = require("@playwright/test")
const { seedFixtureStories } = require("./helpers/stories")
const { openSettingsSection } = require("./helpers/settings")
const { installAiAddon } = require("../shared/ai-addon-ui")
const { triggerMobileBack } = require("./helpers/mobile-app")

// A finger dragged across the tray. Playwright's touchscreen only taps, so the
// touch sequence is dispatched directly; `release` false leaves it mid-swipe.
// Positive travel is a right swipe, negative a left one.
async function traySwipe(tray, travel, release = true) {
  await tray.evaluate((panel, { travel, release }) => {
    const box = panel.getBoundingClientRect()
    const target = panel.querySelector(".addon_tray_header ~ *") || panel
    const startX = travel < 0 ? box.right - 30 : box.left + 30
    const y = box.top + Math.min(60, box.height / 2)
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
    for (let step = 1; step <= 4; step++) fire("touchmove", startX + (travel * step) / 4)
    if (release) fire("touchend", startX + travel)
  }, { travel, release })
}

async function openTray(page, story) {
  await story.getByTestId("story-menu-button").click()
  await page.getByTestId("story-menu").getByText("What? Wait, who, why?", { exact: true }).click()
  const tray = story.getByTestId("addon-tray")
  await expect(tray).toContainText("ExampleApp is software", { timeout: 20000 })
  return tray
}

async function setUp(page) {
  const story = await seedFixtureStories(page)
  await openSettingsSection(page, "addons")
  await installAiAddon(page, new URL(page.url()).origin)
  await page.getByTestId("stories-menu").click()
  return story
}

test("a left swipe on a story's tray closes it, with an indicator while dragging", async ({ page }) => {
  const story = await setUp(page)
  const tray = await openTray(page, story)

  await traySwipe(tray, -40, false)
  await expect(tray).toHaveAttribute("data-tray-swipe", "dragging")
  await expect(tray.locator(".tray_swipe_indicator")).toBeVisible()
  await page.screenshot({ path: "/tmp/once-tray-swipe-close-dragging.png" })
  await traySwipe(tray, -100, false)
  await expect(tray).toHaveAttribute("data-tray-swipe", "armed")
  // Let the badge finish filling in before the screenshot.
  await page.waitForTimeout(200)
  await page.screenshot({ path: "/tmp/once-tray-swipe-close-armed.png" })
  await tray.evaluate(panel => panel.dispatchEvent(new TouchEvent("touchcancel", { bubbles: true })))
  await expect(tray).not.toHaveAttribute("data-tray-swipe")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  // Short of the threshold, the tray settles back and stays open.
  await traySwipe(tray, -40)
  await expect(tray).toBeVisible()
  await expect(tray.locator(".tray_swipe_indicator")).toHaveCount(0)

  await traySwipe(tray, -100)
  await expect(tray).toHaveCount(0)
})

test("a right swipe on a story's tray, or its continue button, moves the conversation to a new tab", async ({ page }) => {
  const story = await setUp(page)
  const tabs = page.locator("#reading_tabs")
  const host = page.locator("#reading_addon_trays")
  const before = Number(await tabs.textContent() || 0)
  const tray = await openTray(page, story)
  await expect(tray.getByTestId("addon-tray-continue")).toHaveText("Continue in new tab")

  await traySwipe(tray, 100, false)
  await expect(tray).toHaveAttribute("data-tray-swipe", "armed")
  await expect(tray).toHaveAttribute("data-tray-swipe-action", "continue")
  await page.waitForTimeout(200)
  await page.screenshot({ path: "/tmp/once-tray-swipe-continue-armed.png" })
  await tray.evaluate(panel => panel.dispatchEvent(new TouchEvent("touchend", { bubbles: true })))

  await expect(page.locator("#left_panel")).toHaveAttribute("active_panel", "reading")
  await expect(tabs).toHaveText(String(before + 1))
  await expect(host).toContainText("ExampleApp is software")
  // Already on the page: there is nowhere further to continue it.
  await expect(host.getByTestId("addon-tray-continue")).toHaveCount(0)
  await page.screenshot({ path: "/tmp/once-tray-swipe-continued.png" })
  // The tray left the list for the tab.
  await page.getByRole("button", { name: "Stories", exact: true }).click()
  await expect(story.getByTestId("addon-tray")).toHaveCount(0)

  await (await openTray(page, story)).getByTestId("addon-tray-continue").click()
  await expect(page.locator("#left_panel")).toHaveAttribute("active_panel", "reading")
  await expect(tabs).toHaveText(String(before + 2))
  await expect(host).toContainText("ExampleApp is software")
  await page.getByRole("button", { name: "Stories", exact: true }).click()
  await expect(story.getByTestId("addon-tray")).toHaveCount(0)
})

test("each reading tab opens and closes the tray on its own, apart from the list", async ({ page }) => {
  const story = await setUp(page)
  const host = page.locator("#reading_addon_trays")
  const stories = () => page.getByRole("button", { name: "Stories", exact: true }).click()
  const selectTab = async index => {
    await page.locator("#reading_tabs").click()
    await page.locator("#reading_tabs_dialog").locator('[data-action="select"]').nth(index).click()
  }
  // Three rounds into three tabs: the conversation shows in each new tab,
  // however often the tray was opened and closed before.
  for (let round = 0; round < 3; round++) {
    await traySwipe(await openTray(page, story), 100)
    await expect(host).toContainText("ExampleApp is software")
    await stories()
    await expect(story.getByTestId("addon-tray")).toHaveCount(0)
  }
  const first = Number(await page.locator("#reading_tabs").textContent()) - 3

  // Closed in one tab, it stays open in the others.
  await page.getByTestId("reading-menu").click()
  await traySwipe(host.getByTestId("addon-tray"), -100)
  await expect(host).toBeHidden()
  await selectTab(first + 1)
  await expect(host).toContainText("ExampleApp is software")
  await selectTab(first + 2)
  await expect(host).toBeHidden()
  await selectTab(first)
  await expect(host).toContainText("ExampleApp is software")

  // Opened again in the list, the tabs keep their own state.
  await stories()
  await openTray(page, story)
  await page.getByTestId("reading-menu").click()
  await expect(host).toContainText("ExampleApp is software")
  await triggerMobileBack(page)
  await expect(host).toBeHidden()
  await stories()
  await expect(story.getByTestId("addon-tray")).toHaveCount(1)
})

test("a left swipe closes the tray over the reading view; a right swipe there opens nothing", async ({ page }) => {
  const story = await setUp(page)
  await traySwipe(await openTray(page, story), 100)
  const host = page.locator("#reading_addon_trays")
  const tray = host.getByTestId("addon-tray")
  await expect(tray).toContainText("ExampleApp is software")
  const tabs = page.locator("#reading_tabs")
  const count = await tabs.textContent()

  await traySwipe(tray, 100)
  await expect(tray).toBeVisible()
  await expect(tabs).toHaveText(count)

  await traySwipe(tray, -100, false)
  await expect(tray).toHaveAttribute("data-tray-swipe", "armed")
  expect(await host.evaluate(view => view.scrollWidth <= view.clientWidth)).toBe(true)
  await page.waitForTimeout(200)
  await page.screenshot({ path: "/tmp/once-tray-swipe-reading-armed.png" })
  await tray.evaluate(panel => panel.dispatchEvent(new TouchEvent("touchend", { bubbles: true })))
  await expect(host).toBeHidden()
  await expect(page.locator("#left_panel")).toHaveAttribute("active_panel", "reading")
})
