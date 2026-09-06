/* global browser, describe, it, $ */
const fixture = require("../shared/ai-addon-fixture")

async function click(selector) {
  const element = await $(selector)
  await element.waitForExist({ timeout: 30000 })
  await browser.execute(query => document.querySelector(query).click(), selector)
}

async function fill(selector, value) {
  const element = await $(selector)
  await element.waitForExist({ timeout: 10000 })
  await browser.execute((target, text) => {
    target.value = text
    target.dispatchEvent(new Event("input", { bubbles: true }))
    target.dispatchEvent(new Event("change", { bubbles: true }))
  }, element, value)
}

describe("Native AI addon", () => {
  it("extracts an article and sends authenticated explanation and summary requests through native HTTP", async () => {
    const platform = String(browser.capabilities.platformName).toLowerCase()
    const baseUrl = process.env.ONCE_MOBILE_TEST_URL || `http://${platform === "android" ? "10.0.2.2" : "127.0.0.1"}:${process.env.ONCE_MOBILE_TEST_PORT}`
    await browser.waitUntil(async () => {
      const contexts = (await browser.getContexts()).map(context => typeof context === "string" ? context : context.id)
      const webview = contexts.find(context => context.includes(platform === "android" ? "WEBVIEW_com.zmarn.once.dev" : "WEBVIEW"))
      if (!webview) return false
      await browser.switchContext(webview)
      return true
    }, { timeout: 60000 })
    await browser.waitUntil(async () => (await $("body").getAttribute("data-once-ready")) === "true", { timeout: 30000 })
    await click("[data-testid='settings-menu']")
    await click("[data-settings-target='sources']")
    if (!(await $("[data-testid='sources']").isDisplayed())) await click("[data-testid='sources-mode-toggle']")
    await fill("[data-testid='sources']", `${baseUrl}/fixtures/feed.rss`)
    await click("[data-testid='save-sources']")
    await click("#settings_section_back")
    await click("[data-settings-target='addons']")
    await click("[data-testid='open-addon-advanced']")
    await fill("[data-testid='addons']", JSON.stringify([fixture.manifest(baseUrl)]))
    await click("[data-testid='save-addons']")
    await click("#settings_section_back")
    await click(".addon_list_row[data-addon-id='what-wait-who-why']")
    const tokenSelector = "[data-testid='addon-option-what-wait-who-why-compatibleToken']"
    await fill(tokenSelector, "fixture-token")
    await browser.execute(target => target.parentElement.querySelector("button").click(), await $(tokenSelector))
    await browser.waitUntil(async () => (await browser.execute(target => target.parentElement.textContent, await $(tokenSelector))).includes("Token saved on this device"), { timeout: 10000 })
    await click("[data-testid='stories-menu']")
    await click("[data-testid='reload-stories']")
    await $("[data-testid='story']").waitForDisplayed({ timeout: 30000 })
    await click("[data-addon-tray-button='addon:what-wait-who-why/assistant']")
    await browser.waitUntil(async () => (await $(".addon_tray").getText()).includes("ExampleApp is software"), { timeout: 30000 })
    await browser.execute(() => Array.from(document.querySelectorAll(".addon_tray button")).find(button => button.textContent === "Summarize").click())
    await browser.waitUntil(async () => (await $(".addon_tray").getText()).includes("Its qualifications are preserved"), { timeout: 30000 })
  })
})
