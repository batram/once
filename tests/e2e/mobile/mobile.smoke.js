/* global browser, describe, it, expect, $ */

function contextName(context) {
  return typeof context === "string" ? context : context?.id || ""
}

async function switchToWebView() {
  const platform = String(browser.capabilities.platformName).toLowerCase()
  let webview = ""
  await browser.waitUntil(async () => {
    const contexts = (await browser.getContexts()).map(contextName)
    webview = platform === "android"
      ? contexts.find((context) => context.includes("WEBVIEW_com.zmarn.once.dev")) || ""
      : contexts.find((context) => context.includes("WEBVIEW")) || ""
    return Boolean(webview)
  }, {
    timeout: 60_000,
    timeoutMsg: "Capacitor WebView did not become available"
  })
  if (platform === "ios") {
    // Right after an app (re)launch the webview is listed before its page is
    // inspectable (title '', url about:blank), so a one-shot title switch can
    // lose the race. Retry until the Once Dev page is actually reachable.
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

// Wait for queued story saves to reach storage (hook set by the e2e build)
// so state survives an app restart without pausing for an arbitrary time.
async function settledStoryWrites() {
  await browser.executeAsync((done) => {
    window.__onceE2E__.settledStoryWrites().then(done, done)
  })
}

async function clickWeb(element, platform) {
  if (platform === "ios") {
    await browser.execute((target) => {
      for (const type of ["mousedown", "mouseup", "click"]) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
      }
    }, element)
  } else {
    await element.click()
  }
}

describe("Once mobile", () => {
  it("launches, loads fixtures, uses the reader, and persists state", async () => {
    await switchToWebView()
    const body = await $("body")
    await body.waitForExist({ timeout: 30_000 })
    try {
      await browser.waitUntil(async () => (await body.getAttribute("data-once-ready")) === "true", {
        timeout: 30_000,
        timeoutMsg: "Once did not finish initializing"
      })
    } catch (error) {
      const stage = await body.getAttribute("data-once-stage")
      const startupError = await body.getAttribute("data-once-error")
      throw new Error(`Once did not finish initializing (stage: ${stage}; error: ${startupError || "none"})`, {
        cause: error
      })
    }
    expect(await $("[data-testid='app-version']").getAttribute("data-build-channel")).toBe("dev")
    await expect($("[data-testid='settings-menu']")).toBeDisplayed()
    await expect($("[data-testid='stories-menu']")).toBeDisplayed()
    await expect($("[data-testid='pick-source']")).not.toBeDisplayed()

    const platform = String(browser.capabilities.platformName).toLowerCase()
    const port = process.env.ONCE_MOBILE_TEST_PORT || "3211"
    const baseUrl = platform === "android" ? `http://10.0.2.2:${port}` : `http://127.0.0.1:${port}`
    await clickWeb(await $("[data-testid='settings-menu']"), platform)
    await $("[data-testid='sources']").setValue(`${baseUrl}/fixtures/feed.rss`)
    await clickWeb(await $("[data-testid='save-sources']"), platform)
    await $("[data-testid='sync-url']").setValue(`http://once-test:once-test@${new URL(baseUrl).host}/db/mobile_${platform}`)
    await clickWeb(await $("[data-testid='save-sync']"), platform)
    if (platform === "ios") {
      await browser.execute(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        window.scrollTo(0, 0)
      })
    }
    await $("[data-testid='theme']").selectByAttribute("value", "light")
    await expect(body).toHaveAttribute("data-theme", "light")

    await clickWeb(await $("[data-testid='stories-menu']"), platform)
    const reloadStories = await $("[data-testid='reload-stories']")
    await reloadStories.waitForDisplayed({ timeout: 10_000 })
    await reloadStories.scrollIntoView()
    await clickWeb(reloadStories, platform)
    const story = await $("[data-testid='story']")
    await story.waitForDisplayed({ timeout: 30_000 })
    await story.scrollIntoView()
    expect((await story.getAttribute("data-title")).includes("Fixture article")).toBe(true)

    await clickWeb(await story.$("[data-testid='story-title']"), platform)
    await browser.switchContext("NATIVE_APP")
    if (platform === "android") {
      await browser.waitUntil(async () => (await browser.getCurrentPackage()) !== "com.zmarn.once.dev", {
        timeout: 30_000,
        timeoutMsg: "Story link did not open in an external browser"
      })
      await browser.pressKeyCode(4)
    } else {
      // SFSafariViewController's dismiss button ("Done" up to iOS 18, "Close"
      // on iOS 26) swallows XCUITest element clicks because the Safari view
      // runs out of process; dismiss it with a device-level coordinate tap.
      const done = await $('-ios predicate string:type == "XCUIElementTypeButton" AND name IN {"Done", "Close"}')
      await done.waitForDisplayed({ timeout: 30_000 })
      const rect = await browser.getElementRect(done.elementId)
      await browser.execute("mobile: tap", {
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2)
      })
      await done.waitForDisplayed({ timeout: 10_000, reverse: true })
    }
    await switchToWebView()

    await clickWeb(await story.$("[data-testid='story-reader']"), platform)
    await $("[data-testid='reader-close']").waitForDisplayed({ timeout: 30_000 })
    if (platform === "android") {
      await browser.switchContext("NATIVE_APP")
      await browser.pressKeyCode(4)
      await switchToWebView()
      await expect($("[data-testid='reader-close']")).not.toBeDisplayed()
    } else {
      await clickWeb(await $("[data-testid='reader-close']"), platform)
    }

    await browser.waitUntil(async () => (await story.getAttribute("class")).includes("read"), {
      timeout: 10_000,
      timeoutMsg: "Reader mode did not persist the read state"
    })
    await clickWeb(await story.$("[data-testid='story-read-state']"), platform)
    await browser.waitUntil(async () => {
      const classes = await story.getAttribute("class")
      return !classes.includes("read") && !classes.includes("skipped")
    }, {
      timeout: 10_000,
      timeoutMsg: "Story did not return to unread state"
    })
    await clickWeb(await story.$("[data-testid='story-read-state']"), platform)
    await browser.waitUntil(async () => (await story.getAttribute("class")).includes("skipped"), {
      timeout: 10_000,
      timeoutMsg: "Story did not enter skipped state"
    })
    await settledStoryWrites()

    await browser.switchContext("NATIVE_APP")
    await browser.terminateApp("com.zmarn.once.dev")
    await browser.activateApp("com.zmarn.once.dev")
    await switchToWebView()
    await clickWeb(await $("[data-testid='stories-menu']"), platform)
    await clickWeb(await $("[data-testid='reload-stories']"), platform)
    const restored = await $("[data-testid='story']")
    await restored.waitForDisplayed({ timeout: 30_000 })
    expect((await restored.getAttribute("class")).includes("skipped")).toBe(true)
    await clickWeb(await $("[data-testid='settings-menu']"), platform)
    const syncUrl = await $("[data-testid='sync-url']")
    expect(String(await syncUrl.getProperty("value")).includes(`/db/mobile_${platform}`)).toBe(true)
  })
})
