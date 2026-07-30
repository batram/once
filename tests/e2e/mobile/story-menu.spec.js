const { test, expect } = require("@playwright/test")
const {
  gotoMobileApp,
  reloadMobileApp,
  testServerUrl
} = require("./helpers/mobile-app")
const {
  openSettingsSection,
  saveSourcesAndWait,
  waitForSwipeSettings
} = require("./helpers/settings")
const { openStoryMenu, seedFixtureStories } = require("./helpers/stories")
const { dragStory } = require("./helpers/swipe")

test("the ⋮ button opens the story menu anchored above the tab bar", async ({ page }) => {
  await gotoMobileApp(page)
  await openSettingsSection(page, "sources")
  await page.getByTestId("sources").fill(await testServerUrl(page, "/fixtures/feed.rss"))
  await saveSourcesAndWait(page)
  await reloadMobileApp(page)
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()

  const story = page.getByTestId("story").filter({ hasText: "Fixture article" })
  await expect(story).toBeVisible()

  // A tap on ⋮ opens the menu directly — no long-press, no swipe armed.
  await story.getByTestId("story-menu-button").click()
  const menu = page.getByTestId("story-menu")
  await expect(menu).toBeVisible()
  await expect(page.getByTestId("story-menu-open-comments")).toBeVisible()
  await expect(page.getByTestId("story-menu-open-browser")).toBeVisible()
  await expect(page.getByTestId("story-menu-open-reader")).toBeVisible()
  // Tab-target actions belong to desktop only.
  await expect(page.getByTestId("story-menu-open-new-tab")).toHaveCount(0)

  const geometry = await menu.evaluate((panel) => {
    const rect = panel.getBoundingClientRect()
    const rowEl = document.querySelector("story-item")
    const row = rowEl.getBoundingClientRect()
    const tabs = document.querySelector("#menu").getBoundingClientRect()
    const button = document
      .querySelector("story-item .menu_btn")
      .getBoundingClientRect()
    const data = rowEl.querySelector(".data").getBoundingClientRect()
    const title = rowEl.querySelector(".title").getBoundingClientRect()
    return {
      // right-aligned to the row it belongs to
      rightGap: Math.abs(rect.right - row.right),
      // never reaches behind the fixed tab bar
      clearsTabBar: rect.bottom <= tabs.top,
      buttonHeight: Math.round(button.height),
      buttonWidth: Math.round(button.width),
      buttonRightGap: Math.round(row.right - button.right),
      buttonBottomGap: Math.round(row.bottom - button.bottom),
      // The button no longer consumes a full-height column beside the title.
      titleRightGap: Math.round(data.right - title.right)
    }
  })
  expect(geometry.rightGap).toBeLessThanOrEqual(8)
  expect(geometry.clearsTabBar).toBe(true)
  // Compact and inset from the right, while the title keeps the row's full
  // text width.
  expect(geometry.buttonHeight).toBe(28)
  expect(geometry.buttonWidth).toBe(28)
  expect(geometry.buttonRightGap).toBe(12)
  expect(geometry.buttonBottomGap).toBe(16)
  expect(geometry.titleRightGap).toBeLessThanOrEqual(1)

  // Tapping the backdrop dismisses without running an action.
  await page.getByTestId("story-menu-backdrop").click({ position: { x: 5, y: 5 } })
  await expect(menu).toBeHidden()
  await expect(story).not.toHaveClass(/read/)

  // A row low on the screen flips the menu above itself rather than letting it
  // slide behind the tab bar.
  await page.locator("#stories").evaluate((stories) => {
    stories.style.paddingTop = "600px"
  })
  await story.getByTestId("story-menu-button").click()
  await expect(menu).toBeVisible()
  const flipped = await menu.evaluate((panel) => {
    const rect = panel.getBoundingClientRect()
    const row = document.querySelector("story-item").getBoundingClientRect()
    const tabs = document.querySelector("#menu").getBoundingClientRect()
    return {
      above: rect.bottom <= row.top,
      gap: Math.round(row.top - rect.bottom),
      clearsTabBar: rect.bottom <= tabs.top
    }
  })
  expect(flipped.above).toBe(true)
  expect(flipped.gap).toBe(4)
  expect(flipped.clearsTabBar).toBe(true)
})

test("filter actions open a visible editor from the menu and a swipe", async ({ page }) => {
  const story = await seedFixtureStories(page)

  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-filter").click()
  const dialog = page.getByTestId("text-input-dialog")
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId("text-input-value")).toHaveValue("127.0.0.1")
  await page.getByTestId("text-input-cancel").click()
  await expect(dialog).toBeHidden()

  await openSettingsSection(page, "swipe")
  await page.getByTestId("swipe-left-1").selectOption("filter")
  await waitForSwipeSettings(page)
  await page.getByTestId("stories-menu").click()

  const swipe = await dragStory(story, -110, { release: false })
  expect(swipe.action).toBe("filter")
  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
  await expect(dialog).toBeVisible()
  await page.getByTestId("text-input-value").fill("fixture-filter.example")
  await page.getByTestId("text-input-accept").click()
  await expect(dialog).toBeHidden()

  await openSettingsSection(page, "filters")
  await expect(page.locator("#filter_area")).toHaveValue(/fixture-filter\.example/)
})

test("a long-press that becomes a drag shows progress and opens nothing", async ({ page }) => {
  await gotoMobileApp(page)
  await openSettingsSection(page, "sources")
  await page.getByTestId("sources").fill(await testServerUrl(page, "/fixtures/feed.rss"))
  await saveSourcesAndWait(page)
  await reloadMobileApp(page)
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()

  const story = page.getByTestId("story").filter({ hasText: "Fixture article" })
  await expect(story).toBeVisible()

  const result = await story.evaluate(async (row) => {
    const rect = row.getBoundingClientRect()
    const press = (type, x, target) => {
      const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        isPrimary: true,
        pointerId: 7,
        pointerType: "touch",
        button: 0,
        clientX: x,
        clientY: rect.top + 20
      })
      target.dispatchEvent(event)
    }
    press("pointerdown", rect.left + 40, row)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const building = getComputedStyle(row, "::after")
    const started = {
      marked: row.classList.contains("press_building"),
      animation: building.animationName,
      duration: building.animationDuration,
      delay: building.animationDelay,
      height: building.height
    }
    // past MOVE_TOLERANCE_PX — the swipe handler owns the gesture now
    press("pointermove", rect.left + 140, document)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const cancelled = row.classList.contains("press_building")
    press("pointerup", rect.left + 140, document)
    // outlast the 500ms long-press threshold
    await new Promise((resolve) => setTimeout(resolve, 600))
    return { started, cancelled }
  })

  expect(result.started.marked).toBe(true)
  expect(result.started.animation).toBe("once-press-progress")
  expect(result.started.duration).toBe("0.4s")
  expect(result.started.delay).toBe("0.1s")
  expect(result.started.height).toBe("2px")
  expect(result.cancelled).toBe(false)
  await expect(page.getByTestId("story-menu")).toBeHidden()
})
