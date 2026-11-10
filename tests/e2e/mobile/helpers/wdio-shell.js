/* global browser, expect, $ */
// Shared steps for the WebdriverIO (Appium) device suites: mobile.smoke.js,
// mobile.addons.js and mobile.lite-extensions.js drive the same Capacitor
// shell, so the context switching, the e2e hooks (window.__onceE2E__ from
// apps/mobile/src/main.ts), the native menus and the Browser Extensions and
// AI add-on settings steps live here once.
const aiAddonFixture = require("../../shared/ai-addon-fixture")
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
    // Once Lite runs several pages in the app's WebView context (the extension
    // broker, background pages, the reading tab): the shell is the one at the
    // Capacitor origin, whichever window chromedriver landed on.
    await browser.waitUntil(async () => {
      for (const handle of await browser.getWindowHandles()) {
        try {
          await browser.switchToWindow(handle)
          const url = await browser.getUrl()
          if (url.startsWith("https://localhost/") && !url.includes("lite-runtime")) return true
        } catch {
          // The window went away between listing and switching.
        }
      }
      return false
    }, {
      timeout: 60_000,
      timeoutMsg: "Capacitor WebView did not expose the shell page"
    })
    // The shell page is listed as soon as it starts loading, which on Once
    // Lite is well before GeckoView's startup would have let a spec in.
    await waitForOnceReady()
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

// Leaves the session in the native context and clicks the first of `labels`
// that a native menu shows (an action's label depends on the story's state).
async function clickNativeMenuItem(labels, platform = currentPlatform()) {
  await browser.switchContext("NATIVE_APP")
  let row
  await browser.waitUntil(async () => {
    if (platform === "android") {
      const anrDialog = await $("android=new UiSelector().textContains(\"isn't responding\")")
      if (await anrDialog.isDisplayed()) {
        throw new Error("Android system ANR dialog appeared while a native menu was open")
      }
    }
    for (const label of labels) {
      const selector = platform === "ios"
        ? `-ios predicate string:name == "${label}" OR label == "${label}" OR value == "${label}"`
        : `android=new UiSelector().text("${label}")`
      const candidate = await $(selector)
      if (await candidate.isDisplayed()) {
        row = candidate
        return true
      }
    }
    if (platform === "android") {
      // A menu taller than a phone's screen scrolls; its last rows are not in the tree until then.
      for (const label of labels) {
        const scrolled = await $(`android=new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(new UiSelector().text("${label}"))`)
        if (await scrolled.isExisting() && await scrolled.isDisplayed()) {
          row = scrolled
          return true
        }
      }
    }
    return false
  }, {
    timeout: 10_000,
    timeoutMsg: `Native menu item ${labels.join(" / ")} did not appear`
  })
  await row.click()
}

// The AI page redraws its rows whenever settings change, which the add-on
// save and sync both announce, so a row found a moment ago may be gone by the
// time it is clicked. Look it up at click time and retry until `opened` shows.
async function openAiRow(selector, opened) {
  await browser.waitUntil(async () => {
    await browser.execute(rowSelector => {
      const row = document.querySelector(rowSelector)
      if (!row) return
      for (const type of ["mousedown", "mouseup", "click"]) {
        row.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
      }
    }, selector)
    return (await $(opened)).isDisplayed()
  }, { timeout: 10_000, interval: 500, timeoutMsg: `${selector} did not open` })
}

// The AI add-on uses the central AI settings: a connection whose token is kept
// in this device's secret store, and the default model on that connection.
async function configureCentralAi(baseUrl, platform) {
  // iOS can retain AI connections in the Keychain between installs. A plain
  // "Fixture AI" lookup may select an earlier run's now-closed server port.
  const connectionName = `Fixture AI (${new URL(baseUrl).host})`
  for (let level = 0; level < 5 && !(await $("[data-settings-target='ai']").isDisplayed()); level++) {
    await clickWeb(await $("#settings_section_back"), platform)
  }
  await clickWeb(await $("[data-settings-target='ai']"), platform)
  const editor = "#ai_settings .ai_editor:not([hidden])"
  await openAiRow("#ai_settings .ai_add_row[data-ai-focus-key='Add connection']", `${editor} [data-testid='ai-connection-name']`)
  await setWebValue(await $(`${editor} [data-testid='ai-connection-name']`), connectionName)
  // The provider's change handler clears the endpoint, so it goes first.
  await setWebValue(await $(`${editor} [data-testid='ai-connection-provider']`), "compatible")
  await setWebValue(await $(`${editor} [data-testid='ai-connection-endpoint']`), `${baseUrl}/ai-addon/v1/chat/completions`)
  await setWebValue(await $(`${editor} [data-testid='ai-connection-token']`), "fixture-token")
  await clickWeb(await $(`${editor} [data-testid='ai-editor-save']`), platform)
  // The model picker lists the connections it opens with, so it waits for the
  // saved connection's row, which also says the token is kept on the device.
  await $(`#ai_settings .settings_link_row[aria-label='${connectionName}: Compatible server · Token set']`).waitForDisplayed({ timeout: 10_000 })
  await openAiRow("#ai_settings .settings_link_row[data-ai-focus-key='Default model']", `${editor} [data-testid='ai-model-connection']`)
  // Choosing the connection clears the model field, so the model follows it.
  const connection = await $(`${editor} [data-testid='ai-model-connection']`)
  const connectionId = await browser.execute((select, name) =>
    Array.from(select.options).find(option => option.textContent === name)?.value ?? "", connection, connectionName)
  expect(connectionId).not.toBe("")
  await setWebValue(connection, connectionId)
  await setWebValue(await $(`${editor} [data-testid='ai-model-id']`), "fixture")
  await clickWeb(await $(`${editor} [data-testid='ai-editor-save']`), platform)
  await browser.waitUntil(async () => browser.execute(name =>
    document.querySelector("#ai_settings .settings_link_row[data-ai-focus-key='Default model']")
      ?.getAttribute("aria-label") === `Default model: ${name} · fixture`, connectionName), {
    timeout: 10_000,
    timeoutMsg: "The default AI model was not saved"
  })
}

// Waits for `text` in the add-on tray at `tray`, failing at once with the
// add-on's own error when it reports one.
async function waitForAiTrayText(tray, text) {
  let failure = ""
  await browser.waitUntil(async () => {
    failure = await browser.execute(selector =>
      document.querySelector(`${selector} .addon_tray_status--error`)?.textContent ?? "", tray)
    if (failure) return true
    return (await $(tray).getText()).includes(text)
  }, { timeout: 30_000, timeoutMsg: `The AI add-on did not show: ${text}` })
  if (failure) throw new Error(`AI add-on failed: ${failure}`)
}

// From the settings index: installs the "What? Wait, who, why?" example add-on
// against the fixture AI server and gives it a connection and a default model.
async function installAiAddon(baseUrl, platform = currentPlatform()) {
  await clickWeb(await $("[data-settings-target='addons']"), platform)
  await clickWeb(await $("[data-testid='open-addon-advanced']"), platform)
  await setWebValue(await $("[data-testid='addons']"), JSON.stringify([aiAddonFixture.manifest(baseUrl)]))
  await clickWeb(await $("[data-testid='save-addons']"), platform)
  // Saving is asynchronous, and the status line may still read "Saved" from
  // an earlier save, so wait for the add-on's own row in the list.
  await $(".addon_list_row[data-addon-id='what-wait-who-why']").waitForExist({ timeout: 10_000 })
  await configureCentralAi(baseUrl, platform)
}

module.exports = {
  androidEngine,
  androidPackage,
  contextName,
  switchToWebView,
  waitForOnceReady,
  settledStoryWrites,
  evaluateSurface,
  applyExtensionSettings,
  clickWeb,
  setWebValue,
  backToSettingsIndex,
  saveExtensionSettings,
  clickNativeMenuItem,
  installAiAddon,
  waitForAiTrayText,
  SMOKE_USERSCRIPT
}
