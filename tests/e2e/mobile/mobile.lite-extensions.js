/* global browser, describe, before, it, expect, $ */
// Acceptance suite for Once Lite's extension runtime (M3 of
// docs/plans/once-lite-plan.md). Selected by ONCE_MOBILE_LITE_EXTENSIONS=1
// (npm run test:mobile:e2e:android:lite:extensions[:local]); it drives the
// WebView-based Android app, so it only runs with --engine lite.
//
// Like the smoke suite, the phases share one installed app and one WebDriver
// session, each building on the state the last one left; `bail` stops at the
// first failure. Every assertion names the capability it proves so a failing
// phase reads as "scriptlets do not run under a strict CSP", not as a diff.
const assert = require("node:assert/strict")
const {
  androidEngine, androidPackage, contextName, switchToWebView, waitForOnceReady,
  evaluateSurface, applyExtensionSettings, saveExtensionSettings, clickWeb, setWebValue,
  backToSettingsIndex, SMOKE_USERSCRIPT
} = require("./helpers/wdio-shell")

const UBLOCK = "uBlock Origin"
const VIOLENTMONKEY = "Violentmonkey"
// Extension pages load at https://<host>.moz-extension.localhost/<page>
// (apps/mobile/src/lite/protocol.ts); the pages come from the vendored
// manifests (browser_action.default_popup / options_ui.page).
const UBLOCK_POPUP_PAGE = "/popup-fenix.html"
const UBLOCK_OPTIONS_PAGE = "/dashboard.html"
const VIOLENTMONKEY_OPTIONS_PAGE = "/options/index.html"
const EXTENSION_PAGE_HOST = ".moz-extension.localhost"

// Content injection: the script must not see page globals except through
// unsafeWindow, and every GM API it probes must answer.
const CONTENT_USERSCRIPT = `// ==UserScript==
// @name Lite content probe
// @namespace once-e2e
// @match <all_urls>
// @run-at document-start
// @inject-into content
// @grant GM_addStyle
// @grant GM_getValue
// @grant GM_setValue
// @grant GM_xmlhttpRequest
// @grant unsafeWindow
// ==/UserScript==
const root = document.documentElement;
root.dataset.vmStart = document.readyState;
GM_setValue('lite-probe', 'stored');
root.dataset.vmGm = String(GM_getValue('lite-probe', 'missing'));
GM_addStyle('#vm-styled { display: none !important; }');
GM_xmlhttpRequest({
  method: 'GET',
  url: location.origin + '/fixtures/violentmonkey/api.json',
  onload: (response) => { try { root.dataset.vmXhr = JSON.parse(response.responseText).token } catch (error) { root.dataset.vmXhr = 'parse-error: ' + error } },
  onerror: () => { root.dataset.vmXhr = 'error' }
});
document.addEventListener('DOMContentLoaded', () => {
  root.dataset.vmIsolated = typeof window.pageSecret;
  root.dataset.vmUnsafe = String(unsafeWindow.pageSecret);
  root.dataset.vmUnsafeIsWindow = String(unsafeWindow === window);
});`

// Page injection: the script shares the page's world, so it sees the page's
// globals directly and its writes land in the page's variables. `@grant none`
// switches Violentmonkey's window wrapper off (with a grant, `window` inside
// the script is a sandbox that hides the page's own globals, in every browser).
const PAGE_USERSCRIPT = `// ==UserScript==
// @name Lite page probe
// @namespace once-e2e
// @match <all_urls>
// @run-at document-end
// @inject-into page
// @grant none
// ==/UserScript==
const root = document.documentElement;
root.dataset.vmPageSecret = String(window.pageSecret);
root.dataset.vmPageCounter = String(++window.pageCounter);
root.dataset.vmPageStart = document.readyState;`

/** browser.waitUntil whose failure message can describe the last state seen. */
async function waitUntilReporting(condition, { timeout, message }) {
  try {
    await browser.waitUntil(condition, { timeout, timeoutMsg: "pending" })
  } catch (error) {
    if (!/pending|timeout/i.test(String(error.message))) throw error
    throw new Error(typeof message === "function" ? message() : message, { cause: error })
  }
}

function nativeText(text) {
  return `android=new UiSelector().text("${text}")`
}

function nativeTextContains(text) {
  return `android=new UiSelector().textContains("${text}")`
}

function nativeDescriptionStartsWith(text) {
  return `android=new UiSelector().descriptionStartsWith("${text}")`
}

/**
 * The e2e hook that opens a URL: the reading panel's address form. The Lite
 * fixtures set `probeLoaded` from their load event; a page without that
 * script (the smoke suite's article) is opened with `loadProbe: false`.
 */
async function openInBrowser(url, { loadProbe = true } = {}) {
  // The flag belongs to the document being left; a same-URL submit still
  // loads a new document, and the wait below must not read the old one.
  try { await evaluateSurface("delete document.documentElement.dataset.probeLoaded; null") } catch { /* no page yet */ }
  await browser.execute((target) => {
    document.querySelector("#reading_menu_btn")?.click()
    const input = document.querySelector("#reading_url")
    input.focus()
    input.value = target
    input.dispatchEvent(new Event("input", { bubbles: true }))
    document.querySelector("#reading_url_form").requestSubmit()
  }, url)
  const readingContent = await $("#reading_content")
  await readingContent.waitForDisplayed({ timeout: 10_000 })
  await browser.waitUntil(async () =>
    (await readingContent.getAttribute("data-mode")) === "browser" &&
    (await readingContent.getAttribute("data-load-state")) === "ready" &&
    (await $("#reading_url").getProperty("value")) === url, {
    timeout: 30_000,
    timeoutMsg: `${url} did not finish loading in the embedded browser`
  })
  if (!loadProbe) return
  await browser.waitUntil(async () => {
    try { return (await evaluateSurface("document.documentElement.dataset.probeLoaded || null")) === "true" }
    catch { return false }
  }, { timeout: 30_000, timeoutMsg: `${url} did not run its load probe (evaluateSurface)` })
}

/** The uBlock probe pages report into documentElement.dataset; read live values too. */
async function readUblockProbe() {
  return evaluateSurface(`({
    adsEnabledAtTop: document.documentElement.dataset.adsEnabledAtTop || null,
    // The page reports the pinned value itself at load: this probe runs in
    // Once's own world, which shares the DOM but not the page's globals.
    adsEnabled: document.documentElement.dataset.adsEnabled || null,
    adScript: document.documentElement.dataset.adScript || null,
    slotDisplay: getComputedStyle(document.querySelector('.lite-ad-slot')).display,
    htmlFiltered: document.querySelector('#lite-html-filtered') ? 'present' : 'removed',
    title: document.title
  })`)
}

function expectUblockApplied(probe, label) {
  assert.equal(probe.adScript, "blocked",
    `network blocking (${label}): ad.js was ${probe.adScript} although the synced filter list blocks */fixtures/ublock/ad.js$script`)
  assert.equal(probe.slotDisplay, "none",
    `cosmetic filtering (${label}): .lite-ad-slot is display:${probe.slotDisplay}, the <host>##.lite-ad-slot rule did not hide it`)
  assert.equal(probe.adsEnabledAtTop, "false",
    `scriptlet injection (${label}): the set-constant scriptlet did not run before the page's first inline script (liteAdsEnabled was ${probe.adsEnabledAtTop} there)`)
  assert.equal(probe.adsEnabled, "false",
    `scriptlet injection (${label}): liteAdsEnabled is ${probe.adsEnabled} after load; set-constant did not pin it`)
  if (process.env.ONCE_LITE_HTML_FILTERS === "1") {
    assert.equal(probe.htmlFiltered, "removed",
      `HTML filtering (${label}): #lite-html-filtered is still in the document; the <host>##^#lite-html-filtered rule needs response-body filtering`)
  } else if (probe.htmlFiltered !== "removed") {
    console.log(`HTML filtering (${label}) not applied; set ONCE_LITE_HTML_FILTERS=1 to assert it`)
  }
}

async function openSettingsSection(target) {
  await clickWeb(await $("[data-testid='settings-menu']"))
  await backToSettingsIndex("android", { levels: 5, target })
  await clickWeb(await $(`[data-settings-target='${target}']`))
}

// The Browser Extensions overview renders one `.mobile_extension_row` button
// per extension (aria-label "Manage <name>"), with a meta line
// "<version> · Enabled|Disabled[ · Included with Once]"
// (apps/mobile/src/browserExtensionSettings.ts).
async function readExtensionCatalog() {
  await $(".mobile_extension_row").waitForExist({ timeout: 30_000 })
  return browser.execute(() => Array.from(document.querySelectorAll("#extension_settings .mobile_extension_row")).map(row => {
    const meta = row.querySelector(".mobile_extension_meta")?.textContent ?? ""
    return {
      name: row.querySelector(".mobile_extension_title strong")?.textContent ?? "",
      label: row.getAttribute("aria-label"),
      enabled: meta.includes("· Enabled"),
      bundled: meta.includes("Included with Once")
    }
  }))
}

async function openExtensionDetail(name) {
  await openSettingsSection("extensions")
  const row = await $(`#extension_settings .mobile_extension_row[aria-label='Manage ${name}']`)
  await row.waitForExist({ timeout: 30_000 })
  await row.scrollIntoView()
  await clickWeb(row)
  await $("#extension_settings h4").waitForExist({ timeout: 10_000 })
}

/** The extension settings pages' controls are plain buttons found by their label. */
async function clickDetailButton(label) {
  await browser.waitUntil(async () => browser.execute(text => {
    const button = Array.from(document.querySelectorAll("#extension_settings button")).find(node => node.textContent === text)
    if (!button || button.disabled) return false
    button.click()
    return true
  }, label), { timeout: 10_000, timeoutMsg: `the "${label}" button is missing or disabled on the extension detail page` })
}

// hasOptions / hasAction are rendered as the detail page's "Open extension
// settings" / "Open extension action" buttons.
async function readDetailFlags() {
  return browser.execute(() => {
    const labels = Array.from(document.querySelectorAll("#extension_settings button")).map(node => node.textContent)
    return {
      hasOptions: labels.includes("Open extension settings"),
      hasAction: labels.includes("Open extension action"),
      removable: labels.includes("Remove extension…"),
      toggle: labels.find(label => label === "Disable extension" || label === "Enable extension") ?? null
    }
  })
}

/**
 * The shell's extension page frame (apps/mobile/src/extensionPageFrame.ts).
 * The result must not carry a `status` key: Appium reads one as a legacy
 * JSONWP status code and fails the command.
 */
async function readExtensionPageFrame() {
  return browser.execute(() => {
    const frame = document.querySelector("#extension_page_frame")
    if (!frame) return null
    return {
      open: !frame.hidden,
      popup: frame.classList.contains("extension_page_frame--popup"),
      title: frame.querySelector(".extension_page_title")?.textContent ?? "",
      statusText: frame.querySelector(".extension_page_status")?.textContent ?? ""
    }
  })
}

async function waitForExtensionPageFrame({ popup, title }) {
  let last = null
  await waitUntilReporting(async () => {
    last = await readExtensionPageFrame()
    return Boolean(last?.open) && last.popup === popup && (!title || last.title.includes(title))
  }, {
    timeout: 20_000,
    message: () => `extensionPageChanged did not open the ${popup ? "popup" : "options"} frame${title ? ` titled "${title}"` : ""} (frame: ${JSON.stringify(last)})`
  })
  return last
}

async function closeExtensionPageFrame() {
  await clickWeb(await $("#extension_page_frame .extension_page_close"))
  await browser.waitUntil(async () => !(await readExtensionPageFrame())?.open, {
    timeout: 10_000,
    timeoutMsg: "the extension page frame did not close from its Close control"
  })
}

/**
 * Switches to the WebView page whose URL matches. On Lite every extension
 * page is a Chromium WebView of the app: they all share the app's
 * WEBVIEW_<package> context, each as a window of it (chromedriver lists the
 * pages as window handles). Returns to the shell page afterwards.
 */
async function withExtensionPageContext(pagePath, work) {
  await browser.waitUntil(async () => {
    for (const context of await browser.getContexts()) {
      const name = contextName(context)
      if (!name.includes(`WEBVIEW_${androidPackage}`)) continue
      try {
        await browser.switchContext(name)
      } catch { continue }
      for (const handle of await browser.getWindowHandles()) {
        try {
          await browser.switchToWindow(handle)
          const url = await browser.getUrl()
          if (url.includes(EXTENSION_PAGE_HOST) && url.includes(pagePath)) return true
        } catch { /* a page that is already gone or not yet inspectable */ }
      }
    }
    return false
  }, { timeout: 30_000, timeoutMsg: `no WebView page serves https://<host>${EXTENSION_PAGE_HOST}${pagePath}` })
  try {
    return await work()
  } finally {
    await switchToWebView()
  }
}

// The native browser menu (⋮ beside the address bar; NativeBrowserMenu.java)
// lists extensions behind an "Extensions (n)" expander whose rows are the
// extension names; a row with both an action and options has a "⚙" beside it
// (content description "<name> settings").
async function openNativeBrowserMenu() {
  await clickWeb(await $("#reading_browser_menu"))
  await browser.switchContext("NATIVE_APP")
  const expand = await $(nativeDescriptionStartsWith("Extensions ("))
  await expand.waitForDisplayed({ timeout: 10_000 })
  return expand
}

async function tapExtensionMenuRow(name) {
  const expand = await openNativeBrowserMenu()
  const description = await expand.getAttribute("content-desc")
  if (description.endsWith(", collapsed")) await expand.click()
  const row = await $(nativeText(name))
  await row.waitForDisplayed({ timeout: 10_000 })
  await row.click()
  // Back to the shell page: the WebView context has several pages on Lite.
  await switchToWebView()
}

/**
 * Accepts the native prompt an AMO install shows (title "Install <name>",
 * confirm button "Install"; liteManagement.ts). The dialog's positive button
 * is clicked by its Android id, since "Install" is also part of the title.
 */
async function acceptNativePrompt(titleStart) {
  await browser.switchContext("NATIVE_APP")
  await $(nativeTextContains(titleStart)).waitForDisplayed({ timeout: 60_000 })
  await $("android=new UiSelector().resourceId(\"android:id/button1\")").click()
  await switchToWebView()
}

// One device journey across the describe blocks below: each phase builds on
// the state the previous one left, so they run in file order with `bail`.
let baseUrl
let fixtureHost

before(async () => {
  const platform = String(browser.capabilities.platformName).toLowerCase()
  assert.equal(platform, "android", "the Lite extension suite runs on Android only")
  assert.equal(androidEngine, "lite", "the Lite extension suite needs --engine lite (ONCE_MOBILE_ENGINE=lite)")
  const port = process.env.ONCE_MOBILE_TEST_PORT || "3211"
  baseUrl = process.env.ONCE_MOBILE_TEST_URL || `http://10.0.2.2:${port}`
  fixtureHost = new URL(baseUrl).hostname
})

describe("Once Lite extensions: filtering and userscripts", () => {
  it("a. starts on Lite and lists uBlock Origin and Violentmonkey as bundled, enabled extensions", async () => {
    await switchToWebView()
    await browser.setTimeout({ script: 30_000 })
    await waitForOnceReady()
    expect(await $("[data-testid='app-version']").getAttribute("data-build-channel")).toBe("dev")
    await openSettingsSection("extensions")
    const catalog = await readExtensionCatalog()
    // In bundle order: uBlock Origin first, then Violentmonkey (a default sort would put "V" before "u").
    assert.deepEqual(catalog.map(item => item.name), [UBLOCK, VIOLENTMONKEY],
      `extension catalog: Settings → Browser Extensions lists ${JSON.stringify(catalog.map(item => item.name))}, expected exactly the two bundled extensions in bundle order`)
    for (const item of catalog) {
      assert.equal(item.label, `Manage ${item.name}`, `extension catalog: the ${item.name} row is not labelled "Manage ${item.name}"`)
      assert.equal(item.enabled, true, `extension catalog: ${item.name} is not enabled after install`)
      assert.equal(item.bundled, true, `extension catalog: ${item.name} is not marked "Included with Once"`)
    }
    for (const [name, expected] of [[UBLOCK, { hasOptions: true, hasAction: true }], [VIOLENTMONKEY, { hasOptions: true, hasAction: true }]]) {
      await openExtensionDetail(name)
      const flags = await readDetailFlags()
      assert.equal(flags.hasOptions, expected.hasOptions, `extension catalog: ${name} hasOptions should render "Open extension settings"`)
      assert.equal(flags.hasAction, expected.hasAction, `extension catalog: ${name} hasAction should render "Open extension action"`)
      assert.equal(flags.removable, false, `extension catalog: bundled ${name} must not offer removal`)
      assert.equal(flags.toggle, "Disable extension", `extension catalog: enabled ${name} should offer "Disable extension"`)
      await clickWeb(await $("#settings_section_back"))
    }
  })

  it("b. saves the synced filter list and userscripts and gets them acknowledged", async () => {
    await openSettingsSection("sources")
    const sourcesInput = await $("[data-testid='sources']")
    if (!(await sourcesInput.isDisplayed())) await clickWeb(await $("[data-testid='sources-mode-toggle']"))
    await setWebValue(sourcesInput, `${baseUrl}/fixtures/feed.rss`)
    await clickWeb(await $("[data-testid='save-sources']"))
    await backToSettingsIndex("android", { levels: 5, target: "extensions" })
    // saveExtensionSettings ends with applyExtensionSettings, which must
    // resolve: on Lite that is the broker having handed the list to uBlock
    // (dashboard message API) and the scripts to Violentmonkey.
    await saveExtensionSettings(baseUrl, "android", {
      filterLists: [`${baseUrl}/fixtures/lite-filter-list.txt`],
      userscripts: [SMOKE_USERSCRIPT, CONTENT_USERSCRIPT, PAGE_USERSCRIPT]
    })
    const scriptRows = await browser.execute(() =>
      Array.from(document.querySelectorAll("#userscripts_settings .userscript_row")).map(row => row.dataset.enabled))
    assert.deepEqual(scriptRows, ["true", "true", "true"], "synced userscripts: three enabled scripts should be listed after saving")
  })

  it("c. blocks the ad script, hides the ad slots and runs the scriptlet first on the plain probe page", async () => {
    await openInBrowser(`${baseUrl}/fixtures/ublock/page.html`)
    expectUblockApplied(await readUblockProbe(), "page.html")
  })

  it("d. applies the same under a strict CSP header and under a meta CSP", async () => {
    await openInBrowser(`${baseUrl}/fixtures/ublock/strict-csp.html`)
    expectUblockApplied(await readUblockProbe(), "strict-csp.html: per-document nonce path")
    await openInBrowser(`${baseUrl}/fixtures/ublock/meta-csp.html`)
    expectUblockApplied(await readUblockProbe(), "meta-csp.html: main-world evaluation path")
  })

  it("e. runs the synced userscripts at document-start with the GM API and the documented isolation", async () => {
    await openInBrowser(`${baseUrl}/fixtures/violentmonkey/page.html`)
    let probe
    await waitUntilReporting(async () => {
      probe = await evaluateSurface(`({
        ...document.documentElement.dataset,
        styled: getComputedStyle(document.querySelector('#vm-styled')).display
      })`)
      return Boolean(probe.vmXhr) && Boolean(probe.vmIsolated) && Boolean(probe.vmPageSecret)
    }, { timeout: 20_000, message: () => `userscripts: the probes did not all report (${JSON.stringify(probe)})` })
    assert.equal(probe.vmStart, "loading", `userscript @run-at document-start: the content script ran at readyState ${probe.vmStart}`)
    assert.equal(probe.onceUserscriptStart, "loading", `userscript @run-at document-start: the smoke probe ran at readyState ${probe.onceUserscriptStart}`)
    assert.equal(probe.vmGm, "stored", `GM_setValue/GM_getValue round trip: got ${probe.vmGm}`)
    assert.equal(probe.styled, "none", `GM_addStyle: #vm-styled is display:${probe.styled}`)
    assert.equal(probe.vmXhr, "vm-api-ok", `GM_xmlhttpRequest: the same-server JSON answered ${probe.vmXhr}`)
    assert.equal(probe.vmIsolated, "undefined", `content-world isolation: the @inject-into content script saw window.pageSecret as ${probe.vmIsolated}`)
    assert.equal(probe.vmUnsafe, "page-secret", `unsafeWindow: the content script read ${probe.vmUnsafe} instead of the page global`)
    assert.equal(probe.vmUnsafeIsWindow, "false", "unsafeWindow: in the content world unsafeWindow must not be the world's window")
    assert.equal(probe.vmPageSecret, "page-secret", `@inject-into page: the page-world script saw window.pageSecret as ${probe.vmPageSecret}`)
    // The surface evaluates in the bridge world, so the page's own variable is read through the script: 2 means it saw the page's 1.
    assert.equal(probe.vmPageCounter, "2", `@inject-into page: the page-world script's increment of window.pageCounter gave ${probe.vmPageCounter}`)
  })

})

describe("Once Lite extensions: extension pages and management", () => {
  it("f. opens uBlock Origin's popup from the browser menu, showing the host and a blocked count", async () => {
    await openInBrowser(`${baseUrl}/fixtures/popup-probe.html`)
    await tapExtensionMenuRow(UBLOCK)
    await waitForExtensionPageFrame({ popup: true, title: UBLOCK })
    await withExtensionPageContext(UBLOCK_POPUP_PAGE, async () => {
      let popup
      await waitUntilReporting(async () => {
        popup = await browser.execute(() => {
          const hostname = document.querySelector("#hostname")?.textContent.replace(/\u00ad|\u00a0/g, "").trim() ?? ""
          const stats = Array.from(document.querySelectorAll("#basicStats span"))
          const blockedLabel = stats.findIndex(span => span.getAttribute("data-i18n") === "popupBlockedOnThisPage_v2")
          const blocked = blockedLabel >= 0 ? stats[blockedLabel + 1]?.textContent.trim() ?? "" : ""
          return { hostname, blocked, switchOn: document.querySelector("#switch")?.classList.contains("off") === false }
        })
        return popup.hostname !== "" && /[1-9]/.test(popup.blocked)
      }, { timeout: 20_000, message: () => `uBlock popup: it did not report the page's hostname and a blocked count (${JSON.stringify(popup)})` })
      assert.equal(popup.hostname, fixtureHost, `uBlock popup: shows ${popup.hostname}, expected the fixture host ${fixtureHost}`)
      assert.match(popup.blocked, /[1-9]/, `uBlock popup: blocked-on-this-page count is ${popup.blocked}, expected non-zero`)
      assert.equal(popup.switchOn, true, "uBlock popup: the site switch should be on for the fixture host")
    })
    await closeExtensionPageFrame()
  })

  it("g. opens uBlock Origin's dashboard from its settings detail page", async () => {
    await openExtensionDetail(UBLOCK)
    await clickDetailButton("Open extension settings")
    const frame = await waitForExtensionPageFrame({ popup: false })
    assert.ok(frame.title.length > 0, "options page: the extension page frame should carry the page title")
    await withExtensionPageContext(UBLOCK_OPTIONS_PAGE, async () => {
      await browser.waitUntil(async () => browser.execute(() => typeof globalThis.vAPI === "object" && globalThis.vAPI !== null &&
        document.querySelector("iframe#iframe")?.contentDocument?.readyState === "complete"), {
        timeout: 20_000, timeoutMsg: "options page: uBlock's dashboard did not get vAPI and load its pane iframe"
      })
    })
    await closeExtensionPageFrame()
  })

  it("h. reflects a script toggled in Violentmonkey's dashboard in the synced userscripts", async () => {
    await openExtensionDetail(VIOLENTMONKEY)
    await clickDetailButton("Open extension settings")
    await waitForExtensionPageFrame({ popup: false })
    // Violentmonkey's dashboard lists each script with an Enable/Disable
    // toggle: the ghost button bound to the Space hotkey (its tooltip,
    // i18n buttonDisable = "Disable", is only rendered on hover). Toggle the content probe.
    await withExtensionPageContext(VIOLENTMONKEY_OPTIONS_PAGE, async () => {
      // The options page opens on its Settings tab (options_ui's URL ends in #settings); the scripts live on the Installed tab.
      await browser.execute(() => { location.hash = "#scripts" })
      await browser.waitUntil(async () => browser.execute(() =>
        Array.from(document.querySelectorAll(".script")).some(item => item.textContent.includes("Lite content probe"))), {
        timeout: 20_000, timeoutMsg: "Violentmonkey dashboard: the synced scripts are not listed"
      })
      const toggled = await browser.execute(() => {
        const item = Array.from(document.querySelectorAll(".script")).find(node => node.textContent.includes("Lite content probe"))
        const button = item && (item.querySelector("a[data-hotkey='space']") ||
          Array.from(item.querySelectorAll("a, button")).find(node => (node.getAttribute("title") || node.textContent.trim()) === "Disable"))
        if (!button) return false
        button.click()
        return true
      })
      assert.equal(toggled, true, "Violentmonkey dashboard: no Disable control on the content probe's row")
    })
    await closeExtensionPageFrame()
    // dashboardChanged → reconciliation: the shell's userscripts document now
    // carries the script as disabled, which its row and the "off" count show.
    await clickWeb(await $("#settings_section_back"))
    await clickWeb(await $("[data-testid='extension-supplemental']"))
    await browser.waitUntil(async () => browser.execute(() =>
      document.querySelector("#userscripts_settings")?.dataset.enabledCount === "2"), {
      timeout: 20_000,
      timeoutMsg: "dashboardChanged round trip: the synced userscripts document still lists every script as enabled after the dashboard disabled one"
    })
    const rows = await browser.execute(() => Array.from(document.querySelectorAll("#userscripts_settings .userscript_row"))
      .map(row => ({ name: row.querySelector(".userscript_row_title")?.textContent ?? "", enabled: row.dataset.enabled })))
    assert.equal(rows.find(row => row.name === "Lite content probe")?.enabled, "false",
      `dashboardChanged round trip: rows after the toggle are ${JSON.stringify(rows)}`)
    // Back on for the remaining phases, from Once's side this time.
    await browser.execute(() => {
      const row = Array.from(document.querySelectorAll("#userscripts_settings .userscript_row")).find(node => node.textContent.includes("Lite content probe"))
      row?.querySelector("[data-testid='userscript-enabled']")?.click()
    })
    await browser.waitUntil(async () => browser.execute(() =>
      document.querySelector("#userscripts_settings")?.dataset.enabledCount === "3"), { timeout: 10_000, timeoutMsg: "re-enabling the script in Once did not take" })
    await applyExtensionSettings()
  })

  it("i. keeps the catalog and the filtering across a hard restart", async () => {
    await browser.switchContext("NATIVE_APP")
    await browser.terminateApp(androidPackage)
    await browser.activateApp(androidPackage)
    await switchToWebView()
    await waitForOnceReady()
    await openSettingsSection("extensions")
    const catalog = await readExtensionCatalog()
    // Bundle order, as phase a asserts (sorting would put "Violentmonkey" before "uBlock Origin").
    assert.deepEqual(catalog.map(item => `${item.name}:${item.enabled}`), [`${UBLOCK}:true`, `${VIOLENTMONKEY}:true`],
      `storage persistence: after a restart the catalog is ${JSON.stringify(catalog)}`)
    await openInBrowser(`${baseUrl}/fixtures/ublock/page.html`)
    expectUblockApplied(await readUblockProbe(), "page.html after restart: persisted filter list")
  })

  it("j. stops filtering when uBlock Origin is disabled and resumes when re-enabled", async () => {
    await openExtensionDetail(UBLOCK)
    await clickDetailButton("Disable extension")
    await browser.waitUntil(async () => (await readDetailFlags()).toggle === "Enable extension", {
      timeout: 20_000, timeoutMsg: "enable/disable: the detail page did not switch to \"Enable extension\""
    })
    await openInBrowser(`${baseUrl}/fixtures/ublock/page.html`)
    const disabled = await readUblockProbe()
    assert.equal(disabled.adScript, "loaded", `enable/disable: with uBlock disabled ad.js was ${disabled.adScript}, expected loaded`)
    assert.equal(disabled.slotDisplay, "block", `enable/disable: with uBlock disabled .lite-ad-slot is display:${disabled.slotDisplay}`)
    assert.equal(disabled.adsEnabled, "true", `enable/disable: with uBlock disabled liteAdsEnabled is ${disabled.adsEnabled}`)
    await openExtensionDetail(UBLOCK)
    await clickDetailButton("Enable extension")
    await browser.waitUntil(async () => (await readDetailFlags()).toggle === "Disable extension", {
      timeout: 20_000, timeoutMsg: "enable/disable: the detail page did not switch back to \"Disable extension\""
    })
    await openInBrowser(`${baseUrl}/fixtures/ublock/page.html`)
    expectUblockApplied(await readUblockProbe(), "page.html after re-enabling uBlock")
  })

  it("k. installs Dark Reader from its AMO listing, darkens a page, and removes it again", async function () {
    if (process.env.ONCE_TEST_AMO_EXTENSIONS !== "1") {
      console.log("Skipping the live AMO install check; set ONCE_TEST_AMO_EXTENSIONS=1")
      this.skip()
      return
    }
    this.timeout(240_000)
    await openSettingsSection("extensions")
    await clickDetailButton("Install extension")
    await setWebValue(await $("#mobile-extension-source"), "https://addons.mozilla.org/en-US/firefox/addon/darkreader/")
    await clickDetailButton("Review and install")
    await acceptNativePrompt("Install")
    await browser.waitUntil(async () => (await readExtensionCatalog()).some(item => item.name === "Dark Reader" && item.enabled), {
      timeout: 120_000, timeoutMsg: "AMO install: Dark Reader did not appear enabled in the catalog"
    })
    assert.equal((await readExtensionCatalog()).find(item => item.name === "Dark Reader").bundled, false, "AMO install: Dark Reader must not be marked as included")
    await openInBrowser(`${baseUrl}/fixtures/article.html`, { loadProbe: false })
    await browser.waitUntil(async () => {
      const darkest = await evaluateSurface(`document.documentElement.getAttribute('data-darkreader-mode') === 'dynamic'
        ? Math.max(...getComputedStyle(document.body).backgroundColor.match(/[0-9]+/g).map(Number)) : 255`)
      return darkest < 80
    }, { timeout: 30_000, timeoutMsg: "AMO install: Dark Reader did not darken /fixtures/article.html (background probe)" })
    await openExtensionDetail("Dark Reader")
    await clickDetailButton("Remove extension…")
    await clickDetailButton("Remove extension and data")
    // The runtime confirms the removal in a native dialog (title "Remove
    // extension", confirm button "Remove"; liteManagement.ts): it is accepted
    // once it shows, through the dialog's positive button.
    await acceptNativePrompt("Remove extension")
    // The detail page of a removed extension is gone with it; read the catalog from the overview.
    await openSettingsSection("extensions")
    await browser.waitUntil(async () => !(await readExtensionCatalog()).some(item => item.name === "Dark Reader"), {
      timeout: 30_000, timeoutMsg: "AMO install: Dark Reader is still listed after removal"
    })
  })
})
