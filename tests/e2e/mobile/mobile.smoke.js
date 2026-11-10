const { ADDON_INTEGRITY } = require("../shared/addon-fixture")
/* global browser, describe, before, it, expect, $ */
// Shell steps shared with mobile.lite-extensions.js (context switching, the
// __onceE2E__ hooks and the Browser Extensions settings steps).
const {
  androidPackage, switchToWebView, waitForOnceReady, settledStoryWrites,
  evaluateSurface, saveExtensionSettings, clickWeb, setWebValue, backToSettingsIndex,
  clickNativeMenuItem, installAiAddon, waitForAiTrayText
} = require("./helpers/wdio-shell")

// The reader frame is opaque-origin, so automation cannot reach into it.
// Observe the TTS bridge traffic (readerTtsPolyfill -> readerTtsHostBridge)
// from the host page instead: the frame must request the native voices.
async function observeReaderTts() {
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
}

// The ad probe reports from its image's load or error event and the extension
// hides the cosmetic target on its own schedule, so the page's "ready" state
// does not say both have settled: poll, then compare the last reading so a
// failure shows which capability is missing.
async function expectExtensionsApplied() {
  const expected = { start: "loading", gm: "true", userHidden: "none", filterHidden: "none", ad: "blocked" }
  let extensionResult
  try {
    await browser.waitUntil(async () => {
      extensionResult = await evaluateSurface(`({
        start: document.documentElement.dataset.onceUserscriptStart || null,
        gm: document.documentElement.dataset.onceGmValue || null,
        userHidden: getComputedStyle(document.querySelector('#once-userscript-target')).display,
        filterHidden: getComputedStyle(document.querySelector('.once-filter-hide')).display,
        ad: document.querySelector('#once-ad-probe').dataset.result || null
      })`)
      return Object.keys(expected).every(key => extensionResult[key] === expected[key])
    }, { timeout: 10_000 })
  } catch (error) {
    if (extensionResult === undefined) throw error
  }
  expect(extensionResult).toEqual(expected)
}

// The per-story action buttons are hidden on mobile; a long-press on the story
// opens the menu built from describeStoryMenu, which installed apps present
// natively (the DOM menu of the web build is the Playwright suite's). The
// long-press detector listens for pointer events in the page, so drive it with
// synthesized PointerEvents (a real webdriver long-press would trigger the OS
// context menu / text selection instead on some platforms).
// `action` is a StoryMenuActionId, e.g. "open-reader" or "toggle-read".
async function openStoryMenuWithLongPress(target) {
  await browser.execute((el) => {
    window.__onceStoryMenuRequested = false
    document.addEventListener("story-menu-request", () => {
      window.__onceStoryMenuRequested = true
    }, { once: true })
    el.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, isPrimary: true,
      pointerId: 1, pointerType: "touch", button: 0
    }))
  }, target)
  try {
    await browser.waitUntil(
      async () => browser.execute(() => window.__onceStoryMenuRequested === true),
      {
        timeout: 5_000,
        timeoutMsg: "Long-press did not request the story menu"
      }
    )
  } finally {
    await browser.execute((el) => {
      el.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, isPrimary: true,
        pointerId: 1, pointerType: "touch", button: 0
      }))
    }, target)
  }
}

async function storyMenuAction(story, action, platform, { viaLongPress = false } = {}) {
  // State changes re-render the story row, staling old element handles, and
  // browser.execute does not re-fetch stale references — re-resolve first.
  const target = await $(story.selector)
  await target.waitForDisplayed({ timeout: 10_000 })
  if (viaLongPress) {
    await openStoryMenuWithLongPress(target)
  } else {
    const menuButton = await target.$("[data-testid='story-menu-button']")
    await menuButton.waitForDisplayed({ timeout: 10_000 })
    await clickWeb(menuButton, platform)
  }

  await selectNativeStoryMenuAction(action, platform)
  await switchToWebView()
}

const nativeStoryMenuLabels = {
  "addon:what-wait-who-why/explain": ["What? Wait, who, why?"],
  "open": ["Open story"],
  "open-comments": ["Open comments"],
  "open-browser": ["Open in browser"],
  "open-reader": ["Open in reader"],
  "toggle-read": ["Skip reading", "Mark as unread", "Unskip"],
  "toggle-bookmark": ["Bookmark", "Remove bookmark"],
  "filter": ["Filter source", "Edit filter"],
  "search-domain": ["Search this domain"],
  "copy-link": ["Copy link address"]
}

async function selectNativeStoryMenuAction(action, platform) {
  const labels = nativeStoryMenuLabels[action]
  if (!labels) throw new Error(`No native story-menu label for ${action}`)
  await clickNativeMenuItem(labels, platform)
}

// One installed app and one WebDriver session carry across these phases: each
// depends on the state the one before it left behind, which is the point — the
// suite follows a single device journey rather than seven independent cases.
// The tab still holds the page: opening its story again starts no navigation.
async function expectReopenedStoryReady(story, platform) {
  const readingContent = await $("#reading_content")
  await clickWeb(await story.$("[data-testid='story-title']"), platform)
  await readingContent.waitForDisplayed({ timeout: 10_000 })
  await browser.waitUntil(async () =>
    (await readingContent.getAttribute("data-load-state")) === "ready", {
    timeout: 15_000,
    timeoutMsg: "Reopening a story whose page is already loaded stayed on loading"
  })
  await clickWeb(await $("[data-testid='stories-menu']"), platform)
  await readingContent.waitForDisplayed({ timeout: 10_000, reverse: true })
}

// `bail` in the Mocha options stops at the first failure, so a broken early
// phase reports once instead of cascading into six confusing ones.
describe("Once mobile", () => {
  let platform
  let baseUrl

  before(async () => {
    platform = String(browser.capabilities.platformName).toLowerCase()
    const port = process.env.ONCE_MOBILE_TEST_PORT || "3211"
    baseUrl = process.env.ONCE_MOBILE_TEST_URL ||
      (platform === "android" ? `http://10.0.2.2:${port}` : `http://127.0.0.1:${port}`)
  })

  it("attaches to the Capacitor WebView and finishes startup", async () => {
    await switchToWebView()
    await browser.setTimeout({ script: 30_000 })
    await waitForOnceReady()
    expect(await $("[data-testid='app-version']").getAttribute("data-build-channel")).toBe("dev")
    await expect($("[data-testid='settings-menu']")).toBeDisplayed()
    await expect($("[data-testid='stories-menu']")).toBeDisplayed()
    await expect($("[data-testid='pick-source']")).not.toBeDisplayed()
  })

  it("stores sources, sync, and theme through settings", async () => {
    await clickWeb(await $("[data-testid='settings-menu']"), platform)
    await clickWeb(await $("[data-settings-target='sources']"), platform)
    const sourcesInput = await $("[data-testid='sources']")
    if (!(await sourcesInput.isDisplayed())) {
      await clickWeb(await $("[data-testid='sources-mode-toggle']"), platform)
    }
    await setWebValue(sourcesInput, `${baseUrl}/fixtures/feed.rss`)
    await clickWeb(await $("[data-testid='save-sources']"), platform)
    await backToSettingsIndex(platform)
    await clickWeb(await $("[data-settings-target='sync']"), platform)
    await setWebValue(
      await $("[data-testid='sync-url']"),
      `http://once-test:once-test@${new URL(baseUrl).host}/db/mobile_${platform}`
    )
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
    await expect($("body")).toHaveAttribute("data-theme", "light")
    await clickWeb(await $("#settings_section_back"), platform)
    const filterLists = [`${baseUrl}/fixtures/mobile-filter-list.txt`]
    // Only Once Lite hands the lists to uBlock Origin (see the fixture).
    if (process.env.ONCE_MOBILE_ENGINE === "lite") filterLists.push(`${baseUrl}/fixtures/loopback-generic-cosmetics.txt`)
    await saveExtensionSettings(baseUrl, platform, { filterLists })
  })

  it("loads fixture stories and opens one in the embedded browser", async () => {
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
    expect(await $("#reading_url").getProperty("value")).toBe(
      `${baseUrl}/fixtures/article.html`
    )
    await expectExtensionsApplied()
    await clickWeb(await $("[data-testid='stories-menu']"), platform)
    await readingContent.waitForDisplayed({ timeout: 10_000, reverse: true })

    await expectReopenedStoryReady(story, platform)
  })

  it("opens the reader from the native story menu and bridges TTS to the host", async () => {
    const story = await $("[data-testid='story']")
    await story.waitForDisplayed({ timeout: 30_000 })
    await observeReaderTts()
    await storyMenuAction(story, "open-reader", platform, { viaLongPress: true })
    await $("#reading_content").waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(async () =>
      (await browser.execute(() => window.__onceTtsSeen)).length > 0, {
      timeout: 10_000,
      timeoutMsg: "reader frame sent no TTS bridge request to the host"
    })
    const ttsTraffic = await browser.execute(() => window.__onceTtsSeen)
    expect(ttsTraffic.some((message) => message.type === "voices" && message.fromReader)).toBe(true)
  })

  it("leaves the reader with the platform back affordance", async () => {
    if (platform === "android") {
      await browser.switchContext("NATIVE_APP")
      await browser.pressKeyCode(4)
      await switchToWebView()
    } else {
      await clickWeb(await $("[data-testid='stories-menu']"), platform)
    }
    await expect($("#reading_content")).not.toBeDisplayed()
  })

  it("tracks read, unread, and skipped state", async () => {
    const story = await $("[data-testid='story']")
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
  })

  it("restores durable state after a hard restart", async () => {
    await browser.switchContext("NATIVE_APP")
    // The iOS dev bundle id is the Gecko dev package's name, com.zmarn.once.dev.
    await browser.terminateApp(androidPackage)
    await browser.activateApp(androidPackage)
    await switchToWebView()
    // switchToWebView waits for startup on Android only.
    await waitForOnceReady()
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
    await browser.waitUntil(async () =>
      String(await sources.getProperty("value")).includes("/fixtures/feed.rss"), {
      timeout: 10_000,
      timeoutMsg: "The saved source did not survive the restart"
    })
    await backToSettingsIndex(platform)
    await clickWeb(await $("[data-settings-target='sync']"), platform)
    const syncUrl = await $("[data-testid='sync-url']")
    await browser.waitUntil(async () =>
      String(await syncUrl.getProperty("value")).includes(`/db/mobile_${platform}`), {
      timeout: 10_000,
      timeoutMsg: "The saved sync URL did not survive the restart"
    })
  })

  it("runs a scripted add-on in the sandbox frame", async () => {
    await runScriptedAddon(baseUrl, platform)
  })

  it("runs the AI addon through native HTTP with a device-local token", async () => {
    await runAiAddon(baseUrl, platform)
  })
})

// The add-on sandbox on a device: the page is a static asset beside the app,
// loaded in a sandboxed frame by the platform WebView (Android's Chromium,
// iOS's WebKit), and the fixture script's computed badge has to reach the row.
async function runScriptedAddon(baseUrl, platform) {
  await clickWeb(await $("#settings_section_back"), platform)
  await clickWeb(await $("[data-settings-target='addons']"), platform)
  await clickWeb(await $("[data-testid='open-addon-advanced']"), platform)
  await setWebValue(await $("[data-testid='addons']"), JSON.stringify([{
    protocol: 1,
    id: "harness-script",
    name: "Harness Script",
    version: "1.0.0",
    script: { url: `${baseUrl}/fixtures/addon/main.js`, integrity: ADDON_INTEGRITY },
    contributions: [
      { kind: "action", id: "visit", label: "Visit from add-on", surfaces: ["button", "menu"], run: { message: "visit" } },
      { kind: "badge", id: "len", compute: "len" }
    ]
  }]))
  await clickWeb(await $("[data-testid='save-addons']"), platform)
  // The section index (and its summary) is hidden while the detail is open,
  // and WebDriver reads no text from hidden elements, so watch the block's
  // own status line instead.
  await browser.waitUntil(async () =>
    (await $("#addon_install_settings .settings_status").getText()) === "Saved", {
    timeout: 10_000,
    timeoutMsg: "The add-on was not saved"
  })
  await clickWeb(await $("[data-testid='stories-menu']"), platform)
  const story = await $("[data-testid='story']")
  await story.waitForDisplayed({ timeout: 30_000 })
  const title = await story.$("[data-testid='story-title']").getText()
  const badge = await story.$(".addon_badge[data-addon-badge='len']")
  await badge.waitForExist({ timeout: 30_000 })
  await browser.waitUntil(async () => (await badge.getText()) === `len ${title.length}`, {
    timeout: 30_000,
    timeoutMsg: "The sandbox did not answer the badge request"
  })
  expect(await story.$$(".addon_btn[data-story-element='addon:harness-script/visit']")).toHaveLength(1)
  expect(await browser.execute(() => document.querySelectorAll("iframe[data-addon-sandbox]").length)).toBe(1)
}

async function runAiAddon(baseUrl, platform) {
  await clickWeb(await $("[data-testid='settings-menu']"), platform)
  await installAiAddon(baseUrl, platform)
  await clickWeb(await $("[data-testid='stories-menu']"), platform)
  const button = await $("[data-addon-tray-button='addon:what-wait-who-why/assistant']")
  expect(await button.isDisplayed()).toBe(false)
  await storyMenuAction(await $("[data-testid='story']"), "addon:what-wait-who-why/explain", platform)
  await waitForAiTrayText(".addon_tray", "ExampleApp is software")
  await browser.waitUntil(async () => browser.execute(() => Array.from(document.querySelectorAll(".addon_tray summary")).some(fold => fold.textContent === "Summary")), { timeout: 30000 })
  await browser.execute(() => Array.from(document.querySelectorAll(".addon_tray summary")).find(fold => fold.textContent === "Summary").click())
  await waitForAiTrayText(".addon_tray", "Its qualifications are preserved")
}
