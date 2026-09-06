/* global browser, describe, it, $ */
const assert = require("node:assert/strict")
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
    const action = "#stories [data-addon-tray-button='addon:what-wait-who-why/assistant']"
    assert.equal(await $(action).isDisplayed(), false)
    const webview = await browser.getContext()
    await $("#stories [data-testid='story-menu-button']").click()
    await browser.switchContext("NATIVE_APP")
    const entry = await $(platform === "android"
      ? 'android=new UiSelector().text("What? Wait, who, why?")'
      : '-ios predicate string:name == "What? Wait, who, why?"')
    await entry.waitForDisplayed({ timeout: 10000 })
    await browser.saveScreenshot("/tmp/once-android-story-menu.png")
    await entry.click()
    await browser.switchContext(webview)
    await browser.waitUntil(async () => (await $(".addon_tray").getText()).includes("ExampleApp is software"), { timeout: 30000 })
    await browser.execute(() => Array.from(document.querySelectorAll(".addon_tray button")).find(button => button.textContent === "Summarize").click())
    await browser.waitUntil(async () => (await $(".addon_tray").getText()).includes("Its qualifications are preserved"), { timeout: 30000 })
    await $(".addon_tray button[aria-label='Close']").click()
    await click("[data-testid='settings-menu']")
    for (let level = 0; level < 3 && !(await $("[data-settings-target='theme']").isDisplayed()); level++) await click("#settings_section_back")
    await click("[data-settings-target='theme']")
    const mobile = '[id="story-button-mobile-addon:what-wait-who-why/explain"]'
    const desktop = '[id="story-button-desktop-addon:what-wait-who-why/explain"]'
    assert.equal(await $(mobile).isSelected(), false)
    assert.equal(await $(desktop).isSelected(), true)
    await $(mobile).click()
    await $(desktop).click()
    for (const theme of ["light", "dark"]) {
      await fill("#theme_select", theme)
      await click("[data-testid='stories-menu']")
      await $(action).waitForDisplayed()
      const geometry = await browser.execute(selector => {
        const button = document.querySelector(selector).getBoundingClientRect()
        const menu = document.querySelector("#stories story-item .menu_btn").getBoundingClientRect()
        const data = document.querySelector("#stories story-item .data").getBoundingClientRect()
        return { width: button.width, height: button.height, y: button.y, menuY: menu.y,
          menuWidth: menu.width, menuHeight: menu.height, textBottom: data.bottom,
          overflow: document.documentElement.scrollWidth > innerWidth }
      }, action)
      assert.equal(geometry.width, 28)
      assert.equal(geometry.height, 28)
      assert.equal(geometry.width, geometry.menuWidth)
      assert.equal(geometry.height, geometry.menuHeight)
      assert.equal(geometry.y, geometry.menuY)
      assert.ok(geometry.y < geometry.textBottom)
      assert.equal(geometry.overflow, false)
      await browser.saveScreenshot(`/tmp/once-android-buttons-${theme}.png`)
      await $(action).click()
      await $(".addon_tray").waitForDisplayed()
      const tray = await browser.execute(() => {
        const panel = document.querySelector(".addon_tray")
        return { padding: getComputedStyle(panel).padding,
          heights: [...panel.querySelectorAll("button")].map(button => button.getBoundingClientRect().height) }
      })
      assert.equal(tray.padding, "4px 6px 6px")
      for (const height of tray.heights) assert.equal(height, 28)
      await browser.saveScreenshot(`/tmp/once-android-compact-tray-${theme}.png`)
      if (platform === "android") {
        await browser.execute(() => { document.querySelector(".addon_tray").style.minHeight = "200vh" })
        await $("#stories [data-testid='story-menu-button']").click()
        await browser.switchContext("NATIVE_APP")
        await $('android=new UiSelector().text("Open in reader")').waitForDisplayed({ timeout: 10000 })
        await $('android=new UiSelector().text("What? Wait, who, why?")').waitForDisplayed({ timeout: 10000 })
        await browser.saveScreenshot(`/tmp/once-android-expanded-tray-menu-${theme}.png`)
        await browser.back()
        await browser.switchContext(webview)
      }
      await $(".addon_tray button[aria-label='Close']").click()
      await click("[data-testid='settings-menu']")
      await click("[data-settings-target='theme']")
    }
    await browser.refresh()
    await browser.waitUntil(async () => (await $("body").getAttribute("data-once-ready")) === "true", { timeout: 30000 })
    await click("[data-testid='stories-menu']")
    await click("[data-testid='reload-stories']")
    await $(action).waitForDisplayed({ timeout: 30000 })
    await click("[data-testid='settings-menu']")
    await click("[data-settings-target='theme']")
    await $('[id="story-button-mobile-builtin/outline"]').click()
    await click("[data-testid='stories-menu']")
    await $("#stories [data-testid='story-reader']").click()
    await $("#reading_content").waitForDisplayed({ timeout: 30000 })
    assert.equal(await $("#reading_content").getAttribute("data-mode"), "reader")
    const readerFrame = await $(".once-reader-host-frame")
    await readerFrame.waitForDisplayed({ timeout: 30000 })
    await browser.switchToFrame(readerFrame)
    await browser.waitUntil(async () => (await $("article").getText()).includes("Once mobile reader fixture content"), { timeout: 30000 })
    await browser.switchToFrame(null)
    await browser.saveScreenshot("/tmp/once-android-reader-button.png")
    for (const mode of ["reader", "browser"]) {
      if (mode === "browser") {
        await click("#reading_reader_toggle")
        await browser.waitUntil(async () => (await $("#reading_content").getAttribute("data-load-state")) === "ready", { timeout: 30000 })
      }
      await click("#reading_story_menu")
      await browser.switchContext("NATIVE_APP")
      const readingAction = await $(platform === "android"
        ? 'android=new UiSelector().text("What? Wait, who, why?")'
        : '-ios predicate string:name == "What? Wait, who, why?"')
      await readingAction.waitForDisplayed({ timeout: 10000 })
      await readingAction.click()
      await browser.switchContext(webview)
      const readingTray = await $("#reading_addon_trays")
      await readingTray.waitForDisplayed({ timeout: 10000 })
      await browser.waitUntil(async () => (await readingTray.getText()).includes("ExampleApp is software"), { timeout: 30000 })
      await $("#reading_addon_trays textarea").setValue("Who uses it?")
      await browser.execute(() => Array.from(document.querySelectorAll("#reading_addon_trays button")).find(button => button.textContent === "Ask").click())
      await browser.waitUntil(async () => (await readingTray.getText()).includes("Developers use it"), { timeout: 30000 })
      await $("#reading_addon_trays textarea").waitForEnabled({ timeout: 30000 })
      await browser.switchContext("NATIVE_APP")
      await browser.saveScreenshot(`/tmp/once-android-reading-${mode}-tray.png`)
      await browser.switchContext(webview)
      await $("#reading_addon_trays button[aria-label='Close']").click()
      await readingTray.waitForDisplayed({ reverse: true, timeout: 10000 })
      assert.equal(await $("#reading_content").getAttribute("data-mode"), mode)
      if (mode === "browser") {
        await browser.waitUntil(async () => {
          const text = await browser.executeAsync(done => {
            window.__onceE2E__.evaluateSurface("document.body.innerText").then(done, () => done(""))
          })
          return String(text).includes("Once mobile reader fixture content")
        }, { timeout: 30000 })
      }
      await browser.switchContext("NATIVE_APP")
      await browser.saveScreenshot(`/tmp/once-android-reading-${mode}-restored.png`)
      await browser.switchContext(webview)
      for (const action of ["Filter source", "Purge story"]) {
        await click("#reading_story_menu")
        await browser.switchContext("NATIVE_APP")
        await $(platform === "android"
          ? `android=new UiSelector().text("${action}")`
          : `-ios predicate string:name == "${action}"`).click()
        if (action === "Filter source") {
          const cancel = await $(platform === "android"
            ? 'android=new UiSelector().resourceId("android:id/button2")'
            : '-ios predicate string:name == "Cancel"')
          await cancel.waitForDisplayed({ timeout: 10000 })
          await browser.saveScreenshot(`/tmp/once-android-reading-${mode}-filter.png`)
          await cancel.click()
          await browser.switchContext(webview)
          continue
        }
        await browser.switchContext(webview)
        const dialog = await $("dialog[open]")
        await dialog.waitForDisplayed({ timeout: 10000 })
        const bounds = await browser.execute(() => {
          const box = document.querySelector("dialog[open]").getBoundingClientRect()
          return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight }
        })
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height)
        await browser.switchContext("NATIVE_APP")
        await browser.saveScreenshot(`/tmp/once-android-reading-${mode}-${action === "Filter source" ? "filter" : "purge"}.png`)
        await browser.switchContext(webview)
        await $(`[data-testid="${action === "Filter source" ? "text-input-cancel" : "confirm-cancel"}"]`).click()
        await dialog.waitForExist({ reverse: true, timeout: 10000 })
      }
    }


  })
})
