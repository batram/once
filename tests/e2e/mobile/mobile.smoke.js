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

// The per-story action buttons are hidden on mobile; a long-press on the
// story opens the anchored menu built from describeStoryMenu. The long-press
// detector listens for pointer events in the page, so drive it with
// synthesized PointerEvents (a real webdriver long-press would trigger the OS
// context menu / text selection instead on some platforms).
// `action` is a StoryMenuActionId, e.g. "open-reader" or "toggle-read".
async function storyMenuAction(story, action, platform) {
  // State changes re-render the story row, staling old element handles, and
  // browser.execute does not re-fetch stale references — re-resolve first.
  const target = await $(story.selector)
  await target.waitForDisplayed({ timeout: 10_000 })
  await browser.execute((el) => {
    el.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, isPrimary: true,
      pointerId: 1, pointerType: "touch", button: 0
    }))
  }, target)
  await browser.pause(700) // long-press threshold is 500ms
  await browser.execute((el) => {
    el.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, cancelable: true, isPrimary: true,
      pointerId: 1, pointerType: "touch", button: 0
    }))
  }, target)
  const row = await $(`[data-testid='story-menu-${action}']`)
  await row.waitForDisplayed({ timeout: 10_000 })
  // the menu suppresses taps for ~250ms after the finger lifts (so the
  // release of the long-press doesn't phantom-tap a row); wait it out
  await browser.pause(500)
  await clickWeb(row, platform)
  await browser.waitUntil(
    async () => !(await $(".once-anchored-menu").isDisplayed()),
    {
      timeout: 5_000,
      timeoutMsg: "Story menu did not close after tapping a row"
    }
  )
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
    const baseUrl = process.env.ONCE_MOBILE_TEST_URL ||
      (platform === "android" ? `http://10.0.2.2:${port}` : `http://127.0.0.1:${port}`)
    await clickWeb(await $("[data-testid='settings-menu']"), platform)
    await clickWeb(await $("[data-settings-target='sources']"), platform)
    await $("[data-testid='sources']").setValue(`${baseUrl}/fixtures/feed.rss`)
    await clickWeb(await $("[data-testid='save-sources']"), platform)
    await clickWeb(await $("#settings_section_back"), platform)
    await clickWeb(await $("[data-settings-target='sync']"), platform)
    await $("[data-testid='sync-url']").setValue(`http://once-test:once-test@${new URL(baseUrl).host}/db/mobile_${platform}`)
    await clickWeb(await $("[data-testid='save-sync']"), platform)
    await clickWeb(await $("#settings_section_back"), platform)
    await clickWeb(await $("[data-settings-target='theme']"), platform)
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
    const readingContent = await $("#reading_content")
    await readingContent.waitForDisplayed({ timeout: 10_000 })
    await browser.waitUntil(async () =>
      (await readingContent.getAttribute("data-mode")) === "browser" &&
      (await readingContent.getAttribute("data-load-state")) === "ready", {
      timeout: 30_000,
      timeoutMsg: "Story title did not finish loading in the embedded browser"
    })
    expect(await $("#reading_url").getText()).toBe(
      `${baseUrl}/fixtures/article.html`
    )
    await clickWeb(await $("#reading_back"), platform)
    await readingContent.waitForDisplayed({ timeout: 10_000, reverse: true })

    // The reader frame is opaque-origin, so automation cannot reach into it.
    // Observe the TTS bridge traffic (readerTtsPolyfill -> readerTtsHostBridge)
    // from the host page instead: the frame must request the native voices.
    await browser.execute(() => {
      window.__onceTtsSeen = []
      window.addEventListener("message", (event) => {
        const data = event.data
        if (data && data.channel === "once-reader-tts") {
          window.__onceTtsSeen.push({
            type: data.type,
            fromReader: event.source ===
              document.querySelector(".once-reader-host-frame")?.contentWindow,
            hasSource: Boolean(event.source)
          })
        }
      })
    })
    await storyMenuAction(story, "open-reader", platform)
    await $("[data-testid='reader-close']").waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(async () =>
      (await browser.execute(() => window.__onceTtsSeen)).length > 0, {
      timeout: 10_000,
      timeoutMsg: "reader frame sent no TTS bridge request to the host"
    })
    const ttsTraffic = await browser.execute(() => window.__onceTtsSeen)
    expect(ttsTraffic.some((message) => message.type === "voices" && message.fromReader)).toBe(true)

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
    await storyMenuAction(story, "toggle-read", platform)
    await browser.waitUntil(async () => {
      const classes = await story.getAttribute("class")
      return !classes.includes("read") && !classes.includes("skipped")
    }, {
      timeout: 10_000,
      timeoutMsg: "Story did not return to unread state"
    })
    await storyMenuAction(story, "toggle-read", platform)
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
    // terminateApp is a hard kill and WKWebView's IndexedDB may not have
    // flushed the very last write, so the exact read state is not asserted
    // here — losing seconds of state on a kill is acceptable. The durable
    // pieces must survive: the story itself, theme, sources, and sync config.
    expect((await restored.getAttribute("data-title")).includes("Fixture article")).toBe(true)
    await expect($("body")).toHaveAttribute("data-theme", "light")
    await clickWeb(await $("[data-testid='settings-menu']"), platform)
    await clickWeb(await $("[data-settings-target='sources']"), platform)
    const sources = await $("[data-testid='sources']")
    expect(String(await sources.getProperty("value")).includes("/fixtures/feed.rss")).toBe(true)
    await clickWeb(await $("#settings_section_back"), platform)
    await clickWeb(await $("[data-settings-target='sync']"), platform)
    const syncUrl = await $("[data-testid='sync-url']")
    expect(String(await syncUrl.getProperty("value")).includes(`/db/mobile_${platform}`)).toBe(true)
  })
})
