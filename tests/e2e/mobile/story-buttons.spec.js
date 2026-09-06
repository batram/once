const { test, expect } = require("@playwright/test")
const { reloadMobileApp } = require("./helpers/mobile-app")
const { seedFixtureStories } = require("./helpers/stories")
const { openSettingsSection } = require("./helpers/settings")
const { installAiAddon, exerciseAiTray } = require("../shared/ai-addon-ui")

test("story buttons default to the menu and have independent persistent platform choices", async ({ page }) => {
  const story = await seedFixtureStories(page)
  await openSettingsSection(page, "addons")
  await installAiAddon(page, new URL(page.url()).origin)
  await page.getByTestId("stories-menu").click()
  const action = story.locator(".addon_btn")
  await expect(action).toBeHidden()
  const footer = await story.evaluate(row => {
    const tag = row.querySelector(".tag").getBoundingClientRect()
    const menu = row.querySelector(".menu_btn").getBoundingClientRect()
    return { tagTop: tag.top, tagBottom: tag.bottom, menuTop: menu.top, menuBottom: menu.bottom }
  })
  expect(footer.menuTop).toBeLessThan(footer.tagBottom)
  expect(footer.menuBottom).toBeGreaterThan(footer.tagTop)
  await story.evaluate(row => {
    const labels = row.querySelector(".story_tag_labels")
    for (const text of ["python", "vibecoding", "visualization", "another tag"]) {
      const tag = document.createElement("span")
      tag.className = "tag"
      tag.textContent = text
      labels.append(tag)
    }
  })
  const wrapped = await story.evaluate(row => {
    const tag = row.querySelector(".story_tag_labels .tag:last-child").getBoundingClientRect()
    const menu = row.querySelector(".menu_btn").getBoundingClientRect()
    return { tagBottom: tag.bottom, menuTop: menu.top, tagRight: tag.right, menuLeft: menu.left }
  })
  expect(wrapped.menuTop).toBeLessThan(wrapped.tagBottom)
  expect(wrapped.tagRight).toBeLessThan(wrapped.menuLeft)
  await page.screenshot({ path: "/tmp/once-compact-wrapped-tags.png" })
  await story.getByTestId("story-menu-button").click()
  await page.getByTestId("story-menu").getByText("What? Wait, who, why?", { exact: true }).click()
  await expect(story.getByTestId("addon-tray")).toContainText("ExampleApp is software", { timeout: 20000 })
  await story.getByRole("button", { name: "Close", exact: true }).click()
  await openSettingsSection(page, "theme")
  const mobile = page.locator('[id="story-button-mobile-addon:what-wait-who-why/explain"]')
  const desktop = page.locator('[id="story-button-desktop-addon:what-wait-who-why/explain"]')
  await expect(mobile).not.toBeChecked()
  await expect(desktop).toBeChecked()
  await mobile.check()
  await desktop.uncheck()
  for (const theme of ["light", "dark"]) {
    await page.getByTestId("theme").selectOption(theme)
    await page.getByTestId("stories-menu").click()
    await expect(action).toBeVisible()
    const a = await action.boundingBox()
    const m = await story.getByTestId("story-menu-button").boundingBox()
    expect(a.width).toBe(m.width)
    expect(a.height).toBe(m.height)
    expect(a.y).toBe(m.y)
    expect(m.x - a.x - a.width).toBe(4)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/once-story-buttons-${theme}.png` })
    await action.click()
    const tray = story.getByTestId("addon-tray")
    await expect(tray).toContainText("ExampleApp is software")
    const compact = await tray.evaluate(panel => ({
      padding: getComputedStyle(panel).padding,
      buttons: [...panel.querySelectorAll("button")].map(button => ({
        height: button.getBoundingClientRect().height,
        margin: getComputedStyle(button).margin
      }))
    }))
    expect(compact.padding).toBe("4px 6px 6px")
    for (const button of compact.buttons) {
      expect(button.height).toBe(28)
      expect(button.margin).toBe("0px")
    }
    await page.screenshot({ path: `/tmp/once-compact-tray-${theme}.png` })
    await tray.evaluate(panel => { panel.style.minHeight = "200vh" })
    await story.getByTestId("story-menu-button").click()
    const menu = page.getByTestId("story-menu")
    await expect(menu).toBeVisible()
    await expect(menu.getByText("What? Wait, who, why?", { exact: true })).toBeVisible()
    const menuBox = await menu.boundingBox()
    const anchorBox = await story.getByTestId("story-menu-button").boundingBox()
    expect(menuBox.y).toBeGreaterThanOrEqual(anchorBox.y + anchorBox.height)
    expect(menuBox.height).toBeGreaterThan(200)
    expect(Math.abs(menuBox.x + menuBox.width - anchorBox.x - anchorBox.width)).toBeLessThan(1)
    await page.screenshot({ path: `/tmp/once-expanded-tray-menu-${theme}.png` })
    await page.getByTestId("story-menu-backdrop").click({ position: { x: 1, y: 1 } })
    await tray.getByRole("button", { name: "Close", exact: true }).click()
    await openSettingsSection(page, "theme")
  }
  await page.screenshot({ path: "/tmp/once-story-button-settings.png" })
  await reloadMobileApp(page)
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()
  await expect(action).toBeVisible()
  await exerciseAiTray(page, story)
  await openSettingsSection(page, "theme")
  for (const input of await page.locator('[id^="story-button-mobile-"]').all()) await input.check()
  await page.getByTestId("stories-menu").click()
  await page.setViewportSize({ width: 320, height: 740 })
  await story.getByTestId("story-bookmark").click()
  await expect(story).toHaveClass(/stared/)
  const geometry = await story.evaluate(row => {
    const data = row.querySelector(".data").getBoundingClientRect()
    const group = row.querySelector(".button_group").getBoundingClientRect()
    return { textWidth: data.width, actionsTop: group.top, textBottom: data.bottom,
      boxes: [...row.querySelectorAll(".button_group > button:not([hidden])")].map(button => {
        const rect = button.getBoundingClientRect()
        return { width: rect.width, height: rect.height, right: rect.right }
      }) }
  })
  expect(geometry.textWidth).toBeGreaterThan(280)
  expect(geometry.actionsTop).toBeLessThan(geometry.textBottom)
  for (const box of geometry.boxes) {
    expect(box.width).toBe(28)
    expect(box.height).toBe(28)
    expect(box.right).toBeLessThanOrEqual(320)
  }
  const last = await story.getByTestId("story-menu-button").boundingBox()
  expect(last.x + last.width).toBe(Math.max(...geometry.boxes.map(box => box.right)))
  await page.screenshot({ path: "/tmp/once-story-buttons-narrow.png" })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.evaluate(() => {
    document.querySelector('link[href*="mobile.css"]').remove()
    document.body.dataset.platform = "electron"
    document.querySelectorAll("story-item").forEach(row => row.update_complete_story_el())
  })
  await expect(action).toBeHidden()
  await page.screenshot({ path: "/tmp/once-story-buttons-desktop.png" })
})
