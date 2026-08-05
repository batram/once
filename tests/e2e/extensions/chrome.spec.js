const { test, expect, chromium } = require("@playwright/test")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { startLocalSource } = require("./local-source")

test("installed Chrome extension loads, collects, persists settings, and opens a story", async () => {
  const extensionPath = path.resolve(__dirname, "../../../apps/chrome-extension/dist/release")
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "once-chrome-e2e-"))
  const source = await startLocalSource()
  const pageErrors = []
  const testPageUnexpectedRequests = []
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  })
  try {
    await context.route(/^https?:/, async (route) => {
      if (route.request().url().startsWith(source.origin)) {
        await route.continue()
        return
      }
      if (route.request().frame().url().includes("once-e2e=1")) {
        testPageUnexpectedRequests.push(route.request().url())
      }
      await route.abort()
    })
    let [worker] = context.serviceWorkers()
    if (!worker) worker = await context.waitForEvent("serviceworker")
    const extensionId = new URL(worker.url()).host
    const page = await context.newPage()
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await page.goto(`chrome-extension://${extensionId}/static/sidepanel.html?once-e2e=1`)
    await expect(page.locator("body")).toHaveAttribute("data-once-ready", "true")
    await expect(page.locator("body")).toHaveAttribute(
      "data-webext-target",
      "chrome"
    )
    await expect(page.locator("body")).toHaveCSS(
      "font-family",
      "Verdana, Geneva, sans-serif"
    )
    expect(testPageUnexpectedRequests, "initial test-mode load must stay offline").toEqual([])
    await expect(page.getByTestId("stories-menu")).toBeVisible()
    await page.getByTestId("settings-menu").click()
    // A sidepanel cannot cycle tabs, focus an address bar or own a second
    // pane, so those shortcuts must not be offered at all. The one key that
    // does reach it from a page is the extension command, which only Chrome
    // can rebind — listed, but read-only.
    await page.locator('[data-settings-target="keyboard"]').click()
    const shortcuts = page.getByTestId("keyboard-shortcuts")
    await expect(shortcuts.locator('[data-group="stories"]')).toBeVisible()
    await expect(shortcuts.locator('[data-group="browser"]')).toHaveCount(0)
    await expect(shortcuts.locator('[data-group="panes"]')).toHaveCount(0)
    // K, not the C that Once uses in-app and that Firefox takes: Chrome
    // refuses to assign Alt+Shift+C and says so only by leaving the command
    // unbound, the manifest loading without complaint. Measured — it rejects
    // Ctrl+Shift+C too, while taking Alt+Shift+K, Ctrl+Shift+K, Alt+Shift+1
    // and a bare Alt+C — so it is the letter with Shift, not the modifier
    // pattern. Asserted here because a silent refusal has no other symptom.
    await expect(
      shortcuts.locator('[data-group="browser-managed"] .keybinding_managed_chord')
    ).toHaveText(["Ctrl+Shift+Y", "Alt+Shift+K"])
    await expect(
      shortcuts.locator('[data-group="browser-managed"] .keybinding_label')
    ).toHaveText(["Open the Once panel", "Switch between story and comments"])
    await expect(page.getByTestId("keybinding-managed-url").first())
      .toHaveText("chrome://extensions/shortcuts")
    // Chrome lets an extension open chrome:// pages, so the address is not
    // merely copyable here.
    const shortcutsTab = context.waitForEvent("page")
    await page.getByTestId("keybinding-managed-open").first().click()
    const shortcutsPage = await shortcutsTab
    expect(shortcutsPage.url()).toBe("chrome://extensions/shortcuts")
    await shortcutsPage.close()

    await page.getByTestId("settings-menu").click()
    await expect(page.getByTestId("sources")).toBeHidden()
    await page.locator('[data-settings-target="sources"]').click()
    const modeToggle = page.getByTestId("sources-mode-toggle")
    await expect(modeToggle).toHaveText("TXT")
    await expect(modeToggle).toHaveAttribute("aria-label", "Edit as text")
    await expect(modeToggle.locator("xpath=..")).toHaveClass(/\bbar\b/)
    await expect(
      page.locator(
        '[data-settings-section="sources"] .settings_panel_heading'
      )
    ).toBeHidden()
    await page.getByTestId("sources-mode-toggle").click()
    await page.getByTestId("sources").fill(source.source)
    await page.getByTestId("save-sources").click()
    await page.getByTestId("stories-menu").click()
    await page.locator("#searchfield").fill("")
    const story = page.locator("story-item", { hasText: "Extension smoke story" })
    await expect(story).toBeVisible()
    expect(testPageUnexpectedRequests, "saving the local source must stay offline").toEqual([])

    await page.reload()
    await expect(page.locator("body")).toHaveAttribute("data-once-ready", "true")
    expect(testPageUnexpectedRequests, "test-mode reload must stay offline").toEqual([])
    await page.getByTestId("settings-menu").click()
    await expect(page.getByTestId("sources")).toBeHidden()
    await page.locator('[data-settings-target="sources"]').click()
    await page.getByTestId("sources-mode-toggle").click()
    const persistedSources = JSON.parse(await page.getByTestId("sources").inputValue())
    expect(persistedSources.sources).toHaveLength(1)
    expect(persistedSources.sources[0]).toMatchObject({
      url: `${source.origin}/feed.json`,
      collector: "jsonselect"
    })
    await page.getByTestId("stories-menu").click()
    await page.locator("#searchfield").fill("")
    await page.getByTestId("reload-stories").click()
    await expect(story).toBeVisible()
    const opened = context.waitForEvent("page")
    await story.locator("a.title").click()
    await expect(await opened).toHaveURL(`${source.origin}/story`)
    expect(pageErrors).toEqual([])
    expect(testPageUnexpectedRequests).toEqual([])
  } finally {
    await context.close()
    await source.close()
    await fs.rm(userDataDir, { recursive: true, force: true })
  }
})
