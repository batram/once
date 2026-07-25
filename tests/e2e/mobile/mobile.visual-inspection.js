/* global browser, describe, it, expect, $, $$ */

function contextName(context) {
  return typeof context === "string" ? context : context?.id || ""
}

async function switchToWebView() {
  const platform = String(browser.capabilities.platformName).toLowerCase()
  let webview = ""
  await browser.waitUntil(async () => {
    const contexts = (await browser.getContexts()).map(contextName)
    webview = platform === "android"
      ? contexts.find(context => context.includes("WEBVIEW_com.zmarn.once.dev")) || ""
      : contexts.find(context => context.includes("WEBVIEW")) || ""
    return Boolean(webview)
  }, {
    timeout: 60_000,
    timeoutMsg: "Capacitor WebView did not become available"
  })
  if (platform === "ios") {
    await browser.waitUntil(async () => {
      try {
        await browser.switchContext({ title: "Once Dev" })
        return true
      } catch {
        return false
      }
    }, {
      timeout: 60_000,
      timeoutMsg: "Capacitor WebView did not expose the Once Dev page"
    })
  } else {
    await browser.switchContext(webview)
  }
}

async function clickWeb(element, platform) {
  if (platform === "ios") {
    await browser.execute(target => {
      for (const type of ["mousedown", "mouseup", "click"]) {
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0
        }))
      }
    }, element)
  } else {
    await element.click()
  }
}

describe("Once mobile visual inspection", () => {
  it("leaves the app open with deterministic stories", async () => {
    // Inspection sessions deliberately preserve the app after Appium exits.
    // Start each new setup from a fresh process so a native browser surface
    // left open by the previous manual pass cannot cover the shell.
    await browser.switchContext("NATIVE_APP")
    await browser.terminateApp("com.zmarn.once.dev")
    await browser.activateApp("com.zmarn.once.dev")
    await switchToWebView()
    const body = await $("body")
    await body.waitForExist({ timeout: 30_000 })
    await browser.waitUntil(
      async () => (await body.getAttribute("data-once-ready")) === "true",
      { timeout: 30_000, timeoutMsg: "Once did not finish initializing" }
    )

    const platform = String(browser.capabilities.platformName).toLowerCase()
    const port = process.env.ONCE_MOBILE_TEST_PORT
    const baseUrl = process.env.ONCE_MOBILE_TEST_URL ||
      (platform === "android"
        ? `http://10.0.2.2:${port}`
        : `http://127.0.0.1:${port}`)

    await clickWeb(await $("[data-testid='settings-menu']"), platform)
    // A previously open foreground native browser surface is hidden through
    // an asynchronous Capacitor call when the panel changes. Let that native
    // round-trip finish before clicking a settings row in the same bounds.
    await browser.pause(500)
    await clickWeb(await $("[data-settings-target='sources']"), platform)
    await $("[data-testid='sources']").setValue(
      `${baseUrl}/fixtures/visual-feed.rss`
    )
    await clickWeb(await $("[data-testid='save-sources']"), platform)
    await clickWeb(await $("#settings_section_back"), platform)
    await clickWeb(await $("[data-testid='stories-menu']"), platform)

    const reload = await $("[data-testid='reload-stories']")
    await reload.waitForDisplayed({ timeout: 10_000 })
    await clickWeb(reload, platform)
    await browser.waitUntil(
      async () => (await $$("[data-testid='story']")).length >= 8,
      { timeout: 30_000, timeoutMsg: "Visual inspection stories did not load" }
    )
    expect((await $$("[data-testid='story']")).length).toBeGreaterThanOrEqual(8)

    if (process.env.ONCE_MOBILE_VISUAL_OPEN_STORY === "1") {
      const first = await $("[data-testid='story']")
      await clickWeb(await first.$("[data-testid='story-title']"), platform)
      const readingContent = await $("#reading_content")
      await browser.waitUntil(
        async () =>
          (await readingContent.getAttribute("data-load-state")) === "ready",
        {
          timeout: 30_000,
          timeoutMsg: "Visual inspection story did not finish loading"
        }
      )
      if (process.env.ONCE_MOBILE_VISUAL_READER === "1") {
        await clickWeb(await $("#reading_reader_toggle"), platform)
        await $(".once-reader-host").waitForDisplayed({
          timeout: 30_000,
          timeoutMsg: "Visual inspection reader did not become visible"
        })
      }
      return
    }

    // End the automation session on the Stories panel at the top of the list.
    await browser.execute(() => window.scrollTo(0, 0))
  })
})
