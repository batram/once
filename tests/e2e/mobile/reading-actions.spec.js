const { test, expect } = require("@playwright/test")
const { seedFixtureStories } = require("./helpers/stories")
const { triggerMobileBack } = require("./helpers/mobile-app")

for (const mode of ["reader", "browser"]) {
  test(`Reading ${mode} keeps action dialogs usable and reveals domain search`, async ({ page }) => {
    const story = await seedFixtureStories(page)
    await story.getByTestId("story-menu-button").tap()
    await page.getByTestId(mode === "reader" ? "story-menu-open-reader" : "story-menu-open").tap()
    await expect(page.locator("#reading_content")).toHaveAttribute("data-mode", mode)
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.body.dataset.theme = theme }, theme)
      for (const action of ["filter", "purge"]) {
        await page.locator("#reading_story_menu").tap()
        await page.getByTestId(`story-menu-${action}`).tap()
        const dialog = page.getByTestId(action === "filter" ? "text-input-dialog" : "confirm-dialog")
        await expect(dialog).toBeVisible()
        const box = await dialog.boundingBox()
        const panel = await page.locator("#reading_panel").boundingBox()
        expect(box.x).toBeGreaterThanOrEqual(panel.x)
        expect(box.y).toBeGreaterThanOrEqual(panel.y)
        expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width)
        expect(box.y + box.height).toBeLessThanOrEqual(panel.y + panel.height)
        if (action === "filter") await page.getByTestId("text-input-value").fill("example.test")
        await page.screenshot({ path: `/tmp/once-reading-${mode}-${action}-${theme}.png` })
        await triggerMobileBack(page)
        await expect(dialog).toHaveCount(0)
        await expect(page.locator("#reading_content")).toBeVisible()
      }
    }
    await page.locator("#reading_story_menu").tap()
    await page.getByTestId("story-menu-filter").tap()
    await page.getByTestId("text-input-value").fill("example.test")
    await page.getByTestId("text-input-accept").tap()
    await expect(page.getByTestId("text-input-dialog")).toHaveCount(0)
    await page.locator("#reading_story_menu").tap()
    await page.getByTestId("story-menu-search-domain").tap()
    await expect(page.locator("#stories_panel")).toBeVisible()
    await expect(page.locator("#searchfield")).toHaveValue("domain:127.0.0.1")
    await expect(page.locator("#reading_content")).toBeHidden()
  })
}
