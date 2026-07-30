const { expect } = require("@playwright/test")

async function waitForMobileApp(page) {
  await expect(page.locator("body")).toHaveAttribute("data-once-ready", "true")
}

async function gotoMobileApp(page) {
  await page.goto("./")
  await waitForMobileApp(page)
}

async function reloadMobileApp(page) {
  await page.reload()
  await waitForMobileApp(page)
}

async function testServerUrl(page, path) {
  return new URL(path, page.url()).href
}

async function triggerMobileBack(page) {
  return page.evaluate(() => window.__onceE2E__.handleBack())
}

module.exports = {
  waitForMobileApp,
  gotoMobileApp,
  reloadMobileApp,
  testServerUrl,
  triggerMobileBack
}
