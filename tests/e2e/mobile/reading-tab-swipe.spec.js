const { test, expect } = require("@playwright/test")
const { gotoMobileApp } = require("./helpers/mobile-app")
const { openSettingsSection } = require("./helpers/settings")

const dialog = page => page.locator("#reading_tabs_dialog")
const rows = page => dialog(page).locator(".reading_tab_row")

async function seedTabs(page) {
  await page.addInitScript(() => localStorage.setItem("once:mobile-reading-tabs:v1", JSON.stringify({
    version: 1, activeId: "one", tabs: Array.from({ length: 8 }, (_, index) => ({
      id: index ? `tab-${index}` : "one", url: `https://example.test/page-${index}`,
      title: `Example page ${index + 1}`, mode: "browser", story: null, readerScroll: 0
    }))
  })))
  await gotoMobileApp(page)
  await page.getByRole("button", { name: "Reading", exact: true }).click()
  await page.locator("#reading_tabs").click()
}

async function touch(page, row, dx, dy = 0) {
  const bounds = await row.boundingBox()
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
  const input = await page.context().newCDPSession(page)
  await input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
  for (let step = 1; step <= 5; step++) {
    await input.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * step / 5, y: y + dy * step / 5 }] })
  }
  return async (cancel = false) => {
    await input.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] })
    await input.detach()
  }
}

test("tab swipes reveal their action, close left with undo, and open right in both themes", async ({ page }) => {
  await seedTabs(page)
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: theme === "light" ? 320 : 412, height: 915 })
    await openSettingsSection(page, "theme")
    await page.locator("#theme_select").selectOption(theme)
    await page.getByRole("button", { name: "Reading", exact: true }).click()
    await page.locator("#reading_tabs").click()
    const releaseClose = await touch(page, rows(page).nth(1), -100)
    await expect(rows(page).nth(1)).toHaveAttribute("data-swipe-direction", "close")
    await expect(rows(page).nth(1)).toHaveAttribute("data-swipe-ready", "true")
    await expect(rows(page).nth(1).locator(".reading_tab_swipe_hint")).toHaveText("Release to close")
    const feedback = await rows(page).nth(1).evaluate(row => {
      const hint = row.querySelector(".reading_tab_swipe_hint")
      return { width: hint.getBoundingClientRect().width, transform: getComputedStyle(row.querySelector("button")).transform,
        overflow: document.documentElement.scrollWidth > innerWidth }
    })
    expect(feedback.width).toBeCloseTo(100, 0)
    expect(feedback.transform).toContain("-100")
    expect(feedback.overflow).toBe(false)
    await page.screenshot({ path: `/tmp/once-tab-swipe-close-${theme}.png` })
    await releaseClose()
    await expect(rows(page)).toHaveCount(7)
    await expect(dialog(page)).toBeVisible()
    await dialog(page).getByRole("button", { name: "Undo close" }).click()
    await expect(rows(page)).toHaveCount(8)
    const releaseOpen = await touch(page, rows(page).nth(1), 100)
    await expect(rows(page).nth(1)).toHaveAttribute("data-swipe-direction", "open")
    await expect(rows(page).nth(1).locator(".reading_tab_swipe_hint")).toHaveText("Release to open")
    await page.screenshot({ path: `/tmp/once-tab-swipe-open-${theme}.png` })
    await releaseOpen()
    await expect(dialog(page)).not.toBeVisible()
    await expect(page.locator("#reading_url")).toHaveValue("https://example.test/page-1")
  }
})

test("short, cancelled and vertical tab gestures never close or open a tab", async ({ page }) => {
  await seedTabs(page)
  for (const [dx, dy, cancel] of [[35, 0, false], [-35, 0, false], [-100, 0, true], [15, -100, false]]) {
    const release = await touch(page, rows(page).nth(2), dx, dy)
    await release(cancel)
    await expect(rows(page)).toHaveCount(8)
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page).locator("[data-swipe-direction]")).toHaveCount(0)
    await expect(rows(page).first().locator(".reading_tab_swipe_hint")).toBeHidden()
    await expect(page.locator("#reading_url")).toHaveValue("https://example.test/page-0")
  }
  expect(await dialog(page).locator(".reading_tab_rows").evaluate(element => element.scrollTop)).toBeGreaterThan(0)
})
