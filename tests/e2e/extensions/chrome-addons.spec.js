const { test, expect, chromium } = require("@playwright/test")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { ADDON_INTEGRITY } = require("../shared/addon-fixture")
const { startStoryFixture } = require("./local-source")
const { installAiAddon, exerciseAiTray } = require("../shared/ai-addon-ui")

// Chrome ships the add-on sandbox as a manifest `sandbox` page: an
// opaque-origin extension page with its own policy that allows blob: modules.
// The same fixture script the Electron and mobile suites run has to compute a
// badge here and answer a button on the row.
test("a scripted add-on runs in Chrome's sandbox page", async () => {
  test.setTimeout(60_000)
  const extensionPath = path.resolve(__dirname, "../../../apps/chrome-extension/dist/release")
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "once-chrome-addons-"))
  const source = await startStoryFixture()
  const pageErrors = []
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  })
  try {
    await context.route(/^https?:/, async (route) => {
      if (route.request().url().startsWith(source.origin)) await route.continue()
      else await route.abort()
    })
    let [worker] = context.serviceWorkers()
    if (!worker) worker = await context.waitForEvent("serviceworker")
    const extensionId = new URL(worker.url()).host
    const page = await context.newPage()
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await page.goto(`chrome-extension://${extensionId}/static/sidepanel.html?once-e2e=1`)
    await expect(page.locator("body")).toHaveAttribute("data-once-ready", "true")

    await page.getByTestId("settings-menu").click()
    await page.locator('[data-settings-target="sources"]').click()
    if (!(await page.getByTestId("sources").isVisible())) await page.getByTestId("sources-mode-toggle").click()
    await page.getByTestId("sources").fill(source.source)
    await page.getByTestId("save-sources").click()

    await page.locator("#settings_section_back").click()
    await page.locator('[data-settings-target="addons"]').click()
    await require("../shared/addon-settings-ui").addonAdvanced(page)
    await page.getByTestId("addons").fill(JSON.stringify([{
      protocol: 1,
      id: "harness-script",
      name: "Harness Script",
      version: "1.0.0",
      script: { url: `${source.origin}/addon/main.js`, integrity: ADDON_INTEGRITY },
      contributions: [
        { kind: "action", id: "visit", label: "Visit from add-on", surfaces: ["button", "menu"], run: { message: "visit" } },
        { kind: "badge", id: "len", compute: "len" }
      ]
    }]))
    await page.getByTestId("save-addons").click()
    await expect(page.locator('[data-settings-target="addons"] .settings_section_summary'))
      .toHaveText("1 of 1 enabled")

    await page.getByTestId("stories-menu").click()
    await page.getByTestId("reload-stories").click()
    const alpha = page.locator(`#stories story-item[data-href="${source.urls.alpha}"]`)
    await expect(alpha).toBeVisible({ timeout: 15_000 })
    const title = await alpha.locator("a.title").innerText()
    await expect(alpha.locator('.addon_badge[data-addon-badge="len"]')).toHaveText(`len ${title.length}`, { timeout: 15_000 })
    await expect(alpha.locator('.addon_btn[data-story-element="addon:harness-script/visit"]')).toHaveCount(1)
    const frame = page.locator("iframe[data-addon-sandbox]")
    await expect(frame).toHaveCount(1)
    expect(await frame.getAttribute("src")).toBe(`chrome-extension://${extensionId}/static/addon-sandbox.html`)
    await page.getByTestId("settings-menu").click()
    await page.locator('[data-settings-target="addons"]').click()
    await installAiAddon(page, source.origin)
    await page.getByTestId("stories-menu").click()
    await exerciseAiTray(page, alpha)
    await page.getByTestId("settings-menu").click()
    await page.locator('[data-settings-target="addons"]').click()
    await require("../shared/local-addon-fixture").importZip(page)
    await page.getByTestId("stories-menu").click()
    await expect(alpha.locator('[data-addon-badge="ready"]')).toHaveText("Local package ready")
    expect(pageErrors).toEqual([])
  } finally {
    await context.close()
    await source.close()
    await fs.rm(userDataDir, { recursive: true, force: true })
  }
})
