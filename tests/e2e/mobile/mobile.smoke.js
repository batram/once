/* global browser, describe, it, expect, $ */

function contextName(context) {
  return typeof context === "string" ? context : context?.id || ""
}

async function switchToWebView() {
  let webview = ""
  await browser.waitUntil(async () => {
    const contexts = (await browser.getContexts()).map(contextName)
    webview = contexts.find((context) => context.includes("WEBVIEW_com.zmarn.once.dev")) ||
      contexts.find((context) => context.includes("WEBVIEW")) || ""
    return Boolean(webview)
  }, {
    timeout: 60_000,
    timeoutMsg: "Capacitor WebView did not become available"
  })
  await browser.switchContext(webview)
}

describe("Once mobile", () => {
  it("launches, loads fixtures, uses the reader, and persists state", async () => {
    await switchToWebView()
    const body = await $("body")
    await body.waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => (await body.getAttribute("data-once-ready")) === "true")
    expect(await $("[data-testid='app-version']").getAttribute("data-build-channel")).toBe("dev")
    await expect($("[data-testid='settings-menu']")).toBeDisplayed()
    await expect($("[data-testid='stories-menu']")).toBeDisplayed()
    await expect($("[data-testid='pick-source']")).not.toBeDisplayed()

    const platform = String(browser.capabilities.platformName).toLowerCase()
    const port = process.env.ONCE_MOBILE_TEST_PORT || "3211"
    const baseUrl = platform === "android" ? `http://10.0.2.2:${port}` : `http://127.0.0.1:${port}`
    await browser.switchContext("NATIVE_APP")
    await browser.setOrientation("LANDSCAPE")
    await switchToWebView()
    await expect($("[data-testid='stories-menu']")).toBeDisplayed()
    await browser.switchContext("NATIVE_APP")
    await browser.setOrientation("PORTRAIT")
    await switchToWebView()
    await $("[data-testid='settings-menu']").click()
    await $("[data-testid='sources']").setValue(`${baseUrl}/fixtures/feed.rss`)
    await $("[data-testid='save-sources']").click()
    await $("[data-testid='sync-url']").setValue(`http://once-test:once-test@${new URL(baseUrl).host}/db/mobile_${platform}`)
    await $("[data-testid='save-sync']").click()
    await $("[data-testid='theme']").selectByAttribute("value", "light")
    await expect(body).toHaveAttribute("data-theme", "light")

    await $("[data-testid='stories-menu']").click()
    await $("[data-testid='reload-stories']").click()
    const story = await $("[data-testid='story']")
    await story.waitForDisplayed({ timeout: 30_000 })
    expect((await story.getText()).includes("Fixture article")).toBe(true)
    await story.$("[data-testid='story-title']").click()
    await browser.pause(1_000)
    await browser.switchContext("NATIVE_APP")
    if (platform === "android") {
      await browser.pressKeyCode(4)
    } else {
      const done = await $("~Done")
      await done.waitForDisplayed({ timeout: 30_000 })
      await done.click()
    }
    await switchToWebView()
    await story.$("[data-testid='story-reader']").click()
    await $("[data-testid='reader-close']").waitForDisplayed({ timeout: 30_000 })
    if (platform === "android") {
      await browser.switchContext("NATIVE_APP")
      await browser.pressKeyCode(4)
      await switchToWebView()
      await expect($("[data-testid='reader-close']")).not.toBeDisplayed()
    } else {
      await $("[data-testid='reader-close']").click()
    }

    await story.$("[data-testid='story-read-state']").click()
    await story.$("[data-testid='story-read-state']").click()
    expect((await story.getAttribute("class")).includes("skipped")).toBe(true)
    await browser.pause(500)

    await browser.switchContext("NATIVE_APP")
    await browser.terminateApp("com.zmarn.once.dev")
    await browser.activateApp("com.zmarn.once.dev")
    await switchToWebView()
    await $("[data-testid='stories-menu']").click()
    await $("[data-testid='reload-stories']").click()
    const restored = await $("[data-testid='story']")
    await restored.waitForDisplayed({ timeout: 30_000 })
    expect((await restored.getAttribute("class")).includes("skipped")).toBe(true)
    await $("[data-testid='settings-menu']").click()
    expect((await $("[data-testid='sync-url']").getValue()).includes(`/db/mobile_${platform}`)).toBe(true)
  })
})
