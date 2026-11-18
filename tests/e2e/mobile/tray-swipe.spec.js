const { test, expect } = require("@playwright/test")
const { seedFixtureStories } = require("./helpers/stories")
const { openSettingsSection } = require("./helpers/settings")
const { installAiAddon } = require("../shared/ai-addon-ui")
const { touchDrag } = require("./helpers/gestures")
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

test("a left swipe on a story's tray closes it, with an indicator while dragging", async ({ page }, testInfo) => {
  const story = await setUp(page)
  const tray = await openTray(page, story)

  await traySwipe(tray, -40, false)
  await expect(tray).toHaveAttribute("data-tray-swipe", "dragging")
  await expect(tray.locator(".tray_swipe_indicator")).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("tray-swipe-close-dragging.png") })
  await traySwipe(tray, -100, false)
  await expect(tray).toHaveAttribute("data-tray-swipe", "armed")
  // The badge is still filling in; the screenshot takes it at its end state.
  await page.screenshot({ path: testInfo.outputPath("tray-swipe-close-armed.png"), animations: "disabled" })
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

test("closing a long tray returns to its story at the opening position", async ({ page }) => {
  // Enough real rows on either side that collapsing the tray cannot restore
  // the story just by hitting the beginning or end of the list.
  await page.route("**/fixtures/feed.rss", async route => {
    const response = await route.fetch()
    const items = Array.from({ length: 80 }, (_, i) => {
      const url = new URL(`/fixtures/story-${i}`, route.request().url())
      const date = new Date(Date.UTC(2030, 6, 15, 10, i - 40, 30)).toUTCString()
      return `<item><title>Feed story ${i}</title><link>${url}</link><pubDate>${date}</pubDate></item>`
    })
    await route.fulfill({ response, body: (await response.text()).replace("</channel>", items.join("") + "</channel>") })
  })
  await page.route("**/ai-addon/v1/chat/completions", async route => {
    const response = await route.fetch()
    const result = await response.json()
    const message = result.choices[0].message
    message.content = message.content.replace("for organizing projects.", "for organizing projects." +
      "\n\nEach project keeps the tasks, notes and decisions for that piece of work together.".repeat(80))
    await route.fulfill({ response, json: result })
  })
  const story = await setUp(page)
  const list = page.getByTestId("stories")
  const top = () => story.evaluate(row => row.getBoundingClientRect().top)
  for (const [theme, width, action] of [["light", 360, "close"], ["dark", 412, "continue"]]) {
    await page.setViewportSize({ width, height: 820 })
    await openSettingsSection(page, "theme")
    await page.getByTestId("theme").selectOption(theme)
    await page.getByTestId("stories-menu").click()
    await story.evaluate(row => row.scrollIntoView({ block: "center" }))
    if (action === "continue") await list.evaluate(el => { el.scrollTop += 150 })
    const openedAt = await top()
    const tray = await openTray(page, story)
    // A row disappears above the story while reading. Restoring the old
    // absolute scrollTop would now put a different story at the opening spot.
    await story.evaluate(row => row.previousElementSibling.remove())
    const paragraph = tray.locator(".addon_tray_assistant p").nth(40)
    await paragraph.scrollIntoViewIfNeeded()
    expect(await top()).toBeLessThan(0)
    await page.screenshot({ path: test.info().outputPath(`tray-scrolled-${theme}.png`) })
    const release = await touchDrag(page, paragraph, action === "close" ? -100 : 100)
    await release()
    if (action === "continue") {
      await expect(page.locator("#reading_addon_trays")).toBeVisible()
      await page.getByTestId("stories-menu").click()
    }
    await expect(tray).toHaveCount(0)
    expect(Math.abs(await top() - openedAt)).toBeLessThanOrEqual(1)
    await expect(story.locator("a.title")).toBeInViewport({ ratio: 1 })
    expect(await list.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: test.info().outputPath(`tray-restored-${theme}.png`) })
  }
})

test("a right swipe on a story's tray, or its continue button, moves the conversation to a new tab", async ({ page }, testInfo) => {
  const story = await setUp(page)
  const tabs = page.locator("#reading_tabs")
  const host = page.locator("#reading_addon_trays")
  const before = Number(await tabs.textContent() || 0)
  const tray = await openTray(page, story)
  await expect(tray.getByTestId("addon-tray-continue")).toHaveText("Continue in new tab")

  await traySwipe(tray, 100, false)
  await expect(tray).toHaveAttribute("data-tray-swipe", "armed")
  await expect(tray).toHaveAttribute("data-tray-swipe-action", "continue")
  await page.screenshot({ path: testInfo.outputPath("tray-swipe-continue-armed.png"), animations: "disabled" })
  await tray.evaluate(panel => panel.dispatchEvent(new TouchEvent("touchend", { bubbles: true })))

  await expect(page.locator("#left_panel")).toHaveAttribute("active_panel", "reading")
  await expect(tabs).toHaveText(String(before + 1))
  await expect(host).toContainText("ExampleApp is software")
  // Already on the page: there is nowhere further to continue it.
  await expect(host.getByTestId("addon-tray-continue")).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("tray-swipe-continued.png") })
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
  const tabs = page.locator("#reading_tabs")
  const first = Number(await tabs.textContent() || 0)
  const stories = () => page.getByRole("button", { name: "Stories", exact: true }).click()
  const selectTab = async index => {
    await tabs.click()
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
  await expect(tabs).toHaveText(String(first + 3))

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

test("a left swipe closes the tray over the reading view; a right swipe there opens nothing", async ({ page }, testInfo) => {
  const story = await setUp(page)
  await traySwipe(await openTray(page, story), 100)
  const host = page.locator("#reading_addon_trays")
  const tray = host.getByTestId("addon-tray")
  await expect(tray).toContainText("ExampleApp is software")
  const tabs = page.locator("#reading_tabs")
  const count = await tabs.textContent()

  // With nowhere to continue to, the drag never arms, so its release can
  // commit nothing.
  await traySwipe(tray, 100, false)
  await expect(tray).toHaveAttribute("data-tray-swipe", "dragging")
  await expect(tray).not.toHaveAttribute("data-tray-swipe-action", "continue")
  await tray.evaluate(panel => panel.dispatchEvent(new TouchEvent("touchend", { bubbles: true })))
  await expect(tray).not.toHaveAttribute("data-tray-swipe")
  await expect(tray).toBeVisible()
  await expect(tabs).toHaveText(count)

  await traySwipe(tray, -100, false)
  await expect(tray).toHaveAttribute("data-tray-swipe", "armed")
  expect(await host.evaluate(view => view.scrollWidth <= view.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("tray-swipe-reading-armed.png"), animations: "disabled" })
  await tray.evaluate(panel => panel.dispatchEvent(new TouchEvent("touchend", { bubbles: true })))
  await expect(host).toBeHidden()
  await expect(page.locator("#left_panel")).toHaveAttribute("active_panel", "reading")
})
