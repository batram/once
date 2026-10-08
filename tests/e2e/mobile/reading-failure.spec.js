const { test, expect } = require("@playwright/test")
const { gotoMobileApp } = require("./helpers/mobile-app")
const { openSettingsSection } = require("./helpers/settings")

for (const colorScheme of ["light", "dark"]) {
  test(`browser failures expose recovery controls in ${colorScheme} mode`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 440, height: 956 })
    await page.emulateMedia({ colorScheme })
    await gotoMobileApp(page)
    await openSettingsSection(page, "theme")
    await page.getByTestId("theme").selectOption(colorScheme)
    await expect(page.locator("body")).toHaveAttribute("data-theme", colorScheme)
    await page.getByTestId("reading-menu").click()
    const address = page.getByTestId("reading-url-input")
    const url = "https://example.test/unavailable"
    await address.fill(url)
    await address.press("Enter")
    await expect(page.locator("#reading_content")).toHaveAttribute("data-load-state", "ready")
    await page.evaluate(() => window.__onceE2E__.failReading("The Internet connection appears to be offline."))
    const error = page.locator("#reading_error")
    await expect(error).toBeVisible()
    await expect(page.locator("#reading_browser_loading")).toBeHidden()
    await expect(error).toContainText("This page couldn’t be opened")
    await expect(error).toContainText("The Internet connection appears to be offline.")
    const geometry = await error.evaluate(element => {
      const box = element.getBoundingClientRect()
      const parent = element.parentElement.getBoundingClientRect()
      return {
        inside: box.left >= parent.left && box.right <= parent.right && box.top >= parent.top && box.bottom <= parent.bottom,
        overflow: element.scrollWidth > element.clientWidth,
        buttons: [...element.querySelectorAll("button")].map(button => {
          const rect = button.getBoundingClientRect()
          return { height: rect.height, inside: rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom }
        })
      }
    })
    expect(geometry.inside).toBe(true)
    expect(geometry.overflow).toBe(false)
    for (const button of geometry.buttons) {
      expect(button.height).toBeGreaterThanOrEqual(44)
      expect(button.inside).toBe(true)
    }
    await page.screenshot({ path: testInfo.outputPath(`browser-failure-${colorScheme}.png`) })
    const editor = page.getByTestId("address-editor-input")
    await error.getByRole("button", { name: "Edit address" }).click()
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue(url)
    await editor.press("Escape")
    await expect(editor).toBeHidden()
    await error.getByRole("button", { name: "Try again" }).click()
    await expect(error).toBeHidden()
    await expect(address).toHaveValue(url)
    await expect(page.locator("#reading_content")).toHaveAttribute("data-load-state", "ready")

    await page.setViewportSize({ width: 320, height: 568 })
    await page.evaluate(() => window.__onceE2E__.failReading("The server could not be reached at https://example.test/" + "long-address-".repeat(30)))
    await expect(error).toBeVisible()
    expect(await error.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await error.getByRole("button", { name: "Edit address" }).click()
    await expect(editor).toBeFocused()
    await editor.fill("http://example.test/recovered")
    await editor.press("Enter")
    await expect(error).toBeHidden()
    await expect(page.locator("#reading_content")).toHaveAttribute("data-load-state", "ready")
  })
}
