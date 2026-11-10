/* global browser, describe, before, it, $ */
// The AI add-on in the Reading view of the installed app, where its tray sits
// beside the reader frame or the native browser surface and its actions come
// from the native Reading story menu. Selected with `--suite addons`
// (npm run test:mobile:e2e:android:addons[:local], …:ios:addons). The smoke
// suite covers the same add-on in the story list.
//
// As there, the phases share one installed app and one WebDriver session and
// each builds on the state the last one left; `bail` stops at the first failure.
const {
  switchToWebView, waitForOnceReady, evaluateSurface, clickWeb, setWebValue,
  backToSettingsIndex, clickNativeMenuItem, installAiAddon, waitForAiTrayText
} = require("./helpers/wdio-shell")

const ADDON_ACTION = "What? Wait, who, why?"
const READING_TRAY = "#reading_addon_trays"
const ARTICLE_TEXT = "Once mobile reader fixture content"

async function waitForReadingMode(mode) {
  const content = await $("#reading_content")
  await content.waitForDisplayed({ timeout: 30_000 })
  await browser.waitUntil(async () =>
    (await content.getAttribute("data-mode")) === mode &&
    (await content.getAttribute("data-load-state")) === "ready", {
    timeout: 30_000,
    timeoutMsg: `The Reading view did not finish loading in ${mode} mode`
  })
}

// The Reading story menu is native; choosing an item leaves the session in the
// native context, which is where a native prompt would have to be answered.
async function chooseReadingMenuItem(label, platform) {
  await clickWeb(await $("#reading_story_menu"), platform)
  await clickNativeMenuItem([label], platform)
}

async function clickTrayButton(label) {
  await browser.waitUntil(async () => browser.execute((tray, text) => {
    const button = Array.from(document.querySelectorAll(`${tray} button`))
      .find(candidate => candidate.textContent === text && !candidate.disabled)
    button?.click()
    return Boolean(button)
  }, READING_TRAY, label), {
    timeout: 10_000,
    timeoutMsg: `The Reading tray has no enabled "${label}" button`
  })
}

describe("Once mobile AI add-on in the Reading view", () => {
  let platform
  let baseUrl

  before(async () => {
    platform = String(browser.capabilities.platformName).toLowerCase()
    const port = process.env.ONCE_MOBILE_TEST_PORT || "3211"
    baseUrl = process.env.ONCE_MOBILE_TEST_URL ||
      (platform === "android" ? `http://10.0.2.2:${port}` : `http://127.0.0.1:${port}`)
  })

  it("installs the AI add-on and loads the fixture stories", async () => {
    await switchToWebView()
    await browser.setTimeout({ script: 30_000 })
    await waitForOnceReady()
    await clickWeb(await $("[data-testid='settings-menu']"), platform)
    await clickWeb(await $("[data-settings-target='sources']"), platform)
    const sourcesInput = await $("[data-testid='sources']")
    if (!(await sourcesInput.isDisplayed())) {
      await clickWeb(await $("[data-testid='sources-mode-toggle']"), platform)
    }
    await setWebValue(sourcesInput, `${baseUrl}/fixtures/feed.rss`)
    await clickWeb(await $("[data-testid='save-sources']"), platform)
    await backToSettingsIndex(platform, { target: "addons" })
    await installAiAddon(baseUrl, platform)
    await clickWeb(await $("[data-testid='stories-menu']"), platform)
    const reloadStories = await $("[data-testid='reload-stories']")
    await reloadStories.waitForDisplayed({ timeout: 10_000 })
    await clickWeb(reloadStories, platform)
    await $("[data-testid='story']").waitForDisplayed({ timeout: 30_000 })
  })

  for (const mode of ["reader", "browser"]) {
    it(`holds a conversation in the Reading tray and returns to the ${mode}`, async () => {
      if (mode === "reader") {
        const menuButton = await $("[data-testid='story'] [data-testid='story-menu-button']")
        await menuButton.waitForDisplayed({ timeout: 10_000 })
        await clickWeb(menuButton, platform)
        await clickNativeMenuItem(["Open in reader"], platform)
        await switchToWebView()
      } else {
        await clickWeb(await $("#reading_reader_toggle"), platform)
      }
      await waitForReadingMode(mode)

      await chooseReadingMenuItem(ADDON_ACTION, platform)
      await switchToWebView()
      const tray = await $(READING_TRAY)
      await tray.waitForDisplayed({ timeout: 10_000 })
      await waitForAiTrayText(READING_TRAY, "ExampleApp is software")
      // The follow-up goes out with the conversation so far; the fixture
      // server answers it only when it carries the question.
      await setWebValue(await $(`${READING_TRAY} textarea`), "Who uses it?")
      await clickTrayButton("Ask")
      await waitForAiTrayText(READING_TRAY, "Developers use it")
      await $(`${READING_TRAY} textarea`).waitForEnabled({ timeout: 30_000 })

      await clickWeb(await $(`${READING_TRAY} button[aria-label='Close']`), platform)
      await tray.waitForDisplayed({ reverse: true, timeout: 10_000 })
      // Closing the tray must hand the screen back to what it covered.
      await waitForReadingMode(mode)
      if (mode === "browser") {
        let text = ""
        await browser.waitUntil(async () => {
          text = String(await evaluateSurface("document.body.innerText").catch(() => ""))
          return text.includes(ARTICLE_TEXT)
        }, {
          timeout: 30_000,
          timeoutMsg: "The browser surface did not show the article again after the tray closed"
        })
      }
    })

    it(`answers Filter source and Purge story over the ${mode} with dialogs that stay on screen`, async () => {
      await chooseReadingMenuItem("Filter source", platform)
      const cancel = await $(platform === "android"
        ? 'android=new UiSelector().resourceId("android:id/button2")'
        : '-ios predicate string:type == "XCUIElementTypeButton" AND name == "Cancel"')
      await cancel.waitForDisplayed({ timeout: 10_000 })
      await cancel.click()
      await cancel.waitForDisplayed({ reverse: true, timeout: 10_000 })
      await switchToWebView()

      await chooseReadingMenuItem("Purge story", platform)
      await switchToWebView()
      const dialog = await $("dialog[open]")
      await dialog.waitForDisplayed({ timeout: 10_000 })
      let bounds
      await browser.waitUntil(async () => {
        bounds = await browser.execute(() => {
          const box = document.querySelector("dialog[open]")?.getBoundingClientRect()
          return box && {
            left: box.left, top: box.top, right: box.right, bottom: box.bottom,
            width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight
          }
        })
        return Boolean(bounds) && bounds.width > 0 && bounds.height > 0 &&
          bounds.left >= 0 && bounds.top >= 0 &&
          bounds.right <= bounds.viewportWidth && bounds.bottom <= bounds.viewportHeight
      }, {
        timeout: 10_000,
        timeoutMsg: "The Purge story dialog does not fit the screen"
      })
      await clickWeb(await $("[data-testid='confirm-cancel']"), platform)
      await dialog.waitForExist({ reverse: true, timeout: 10_000 })
      await waitForReadingMode(mode)
    })
  }
})
