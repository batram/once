const { expect } = require("@playwright/test")

async function addonOverview(page) {
  const overview = page.locator("#addon_overview")
  if (!(await overview.isVisible())) await page.locator("#settings_section_back").click()
  await expect(overview).toBeVisible()
}

async function addonImport(page) {
  if (await page.locator("#addon_import").isVisible()) return
  await addonOverview(page)
  await page.getByTestId("open-addon-import").click()
}

async function addonAdvanced(page) {
  if (await page.locator("#addon_advanced").isVisible()) return
  await addonOverview(page)
  await page.getByTestId("open-addon-advanced").click()
}

async function addonSettings(page, id) {
  await addonOverview(page)
  await page.locator(`.addon_list_row[data-addon-id="${id}"]`).click()
}

module.exports = { addonOverview, addonImport, addonAdvanced, addonSettings }
