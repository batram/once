/* global browser, $ */
// Shared steps for the WebdriverIO (Appium) device suites: mobile.smoke.js and
// mobile.lite-extensions.js drive the same Capacitor shell, so the context
// switching, the e2e hooks (window.__onceE2E__ from apps/mobile/src/main.ts)
// and the Browser Extensions settings steps live here once.
const { mobileEngine, packageName } = require("../../../../apps/mobile/scripts/android-engine")

// The Android app under test: com.zmarn.once.dev, or com.zmarn.once.lite.dev for Once Lite.
const androidEngine = mobileEngine()
const androidPackage = packageName(androidEngine, "dev")

function contextName(context) {
  return typeof context === "string" ? context : context?.id || ""
}

function currentPlatform() {
  return String(browser.capabilities.platformName).toLowerCase()
}

async function switchToWebView() {
  const platform = currentPlatform()
  let webview = ""
  await browser.waitUntil(async () => {
    const contexts = (await browser.getContexts()).map(contextName)
    webview = platform === "android"
      ? contexts.find((context) => context.includes(`WEBVIEW_${androidPackage}`)) || ""
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

// Waits for the shell's startup flag, reporting the stage it stalled at.
async function waitForOnceReady() {
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
}

// Wait for queued story saves to reach storage (hook set by the e2e build)
// so state survives an app restart without pausing for an arbitrary time.
async function settledStoryWrites() {
  await browser.executeAsync((done) => {
    window.__onceE2E__.settledStoryWrites().then(done, done)
  })
}

/** Runs `script` in the reading page (both engines) and returns its JSON value. */
async function evaluateSurface(script) {
  const encoded = await browser.executeAsync((source, done) => {
    window.__onceE2E__.evaluateSurface(source).then(done, error => done({ error: String(error) }))
  }, script)
  if (encoded && typeof encoded === "object" && encoded.error) throw new Error(encoded.error)
  return JSON.parse(encoded ?? "null")
}

/** Resolves once the native extension runtime acknowledged the synced settings. */
async function applyExtensionSettings() {
  const failure = await browser.executeAsync(done => {
    window.__onceE2E__.applyExtensionSettings().then(() => done(null), error => done(String(error)))
  })
  if (failure) throw new Error(`applyExtensionSettings was not acknowledged: ${failure}`)
}

async function clickWeb(element, platform = currentPlatform()) {
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

async function setWebValue(element, value) {
  await element.waitForDisplayed({ timeout: 10_000 })
  await browser.execute((target, nextValue) => {
    target.value = nextValue
    target.dispatchEvent(new Event("input", { bubbles: true }))
    target.dispatchEvent(new Event("change", { bubbles: true }))
  }, element, value)
}

// A list's text view is its own settings page, so leaving a section edited
// as text takes one Back to the list and another to the index.
async function backToSettingsIndex(platform = currentPlatform(), { levels = 3, target = "sync" } = {}) {
  for (let level = 0; level < levels && !(await $(`[data-settings-target='${target}']`).isDisplayed()); level++) {
    await clickWeb(await $("#settings_section_back"), platform)
  }
}

/** The userscript the smoke suite installs: document-start timing and the GM value API. */
const SMOKE_USERSCRIPT = `// ==UserScript==
// @name Mobile e2e probe
// @namespace once-e2e
// @match <all_urls>
// @run-at document-start
// @grant GM_addStyle
// @grant GM_getValue
// @grant GM_setValue
// ==/UserScript==
document.documentElement.dataset.onceUserscriptStart = document.readyState;
GM_addStyle('#once-userscript-target { display: none !important; }');
    GM_setValue('ran', true);
    document.documentElement.dataset.onceGmValue = String(GM_getValue('ran', false));`

// Saves fixture filter lists and probing userscripts from the settings index,
// then hands both to the native extension runtime. Both editors are groups of
// the one Extensions section, so this opens it once. On Android the section
// opens on the native extension overview, which keeps the editors one page
// further in. The article fixture carries the elements the default rules and
// script act on; the Lite suite passes its own.
async function saveExtensionSettings(baseUrl, platform, {
  filterLists = [`${baseUrl}/fixtures/mobile-filter-list.txt`],
  userscripts = [SMOKE_USERSCRIPT]
} = {}) {
  await clickWeb(await $("[data-settings-target='extensions']"), platform)
  const supplemental = await $("[data-testid='extension-supplemental']")
  if (await supplemental.isExisting()) await clickWeb(supplemental, platform)
  await setWebValue(await $("[data-testid='filter-lists']"), filterLists.join("\n"))
  await clickWeb(await $("[data-testid='save-filter-lists']"), platform)
  for (const source of userscripts) {
    // Second group of the section: it starts below the fold on a phone screen.
    const addScript = await $("[data-testid='add-userscript']")
    await addScript.waitForExist({ timeout: 10_000 })
    await addScript.scrollIntoView()
    await clickWeb(addScript, platform)
    await setWebValue(await $("[data-testid='userscript-source']"), source)
    const saveScript = await $("[data-testid='save-userscript']")
    await saveScript.scrollIntoView()
    await clickWeb(saveScript, platform)
    await $("[data-testid='userscripts-settings'][data-page='script']").waitForExist()
    if (userscripts.length > 1) {
      // Back to the script list for the next one; the editor is its own page.
      await clickWeb(await $("#settings_section_back"), platform)
      await $("[data-testid='userscripts-settings'][data-page='list']").waitForExist()
    }
  }
  await applyExtensionSettings()
}

module.exports = {
  androidEngine,
  androidPackage,
  contextName,
  currentPlatform,
  switchToWebView,
  waitForOnceReady,
  settledStoryWrites,
  evaluateSurface,
  applyExtensionSettings,
  clickWeb,
  setWebValue,
  backToSettingsIndex,
  saveExtensionSettings,
  SMOKE_USERSCRIPT
}
