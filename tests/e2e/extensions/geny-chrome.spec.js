const { test, expect, chromium } = require("@playwright/test")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const {
  STORY_TITLE,
  startGenyFixture
} = require("../shared/geny-fixture")

test("Chrome genymatch extracts innerText from fetched HTML", async () => {
  const extensionPath = path.resolve(
    __dirname,
    "../../../apps/chrome-extension/dist"
  )
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "once-chrome-geny-"))
  const fixture = await startGenyFixture()
  const pageErrors = []
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  })
  try {
    await context.route(/^https?:/, async (route) => {
      if (route.request().url().startsWith(fixture.origin)) {
        await route.continue()
      } else {
        await route.abort()
      }
    })
    let [worker] = context.serviceWorkers()
    if (!worker) worker = await context.waitForEvent("serviceworker")
    const extensionId = new URL(worker.url()).host
    const page = await context.newPage()
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await page.goto(
      `chrome-extension://${extensionId}/static/sidepanel.html?once-e2e=1`
    )
    await expect(page.locator("body")).toHaveAttribute("data-once-ready", "true")

    await page.getByTestId("settings-menu").click()
    await page.getByTestId("sources").fill(fixture.source)
    await page.getByTestId("save-sources").click()
    await page.getByTestId("stories-menu").locator(":scope > .heading").click()
    await page.locator("#searchfield").fill("")

    const story = page.locator(
      `story-item[data-href="${fixture.storyUrl}"]`
    )
    await expect(story).toBeVisible()
    await expect(story.locator("a.title")).toHaveText(STORY_TITLE)
    await expect(story).toContainText("TypeScript")
    expect(pageErrors).toEqual([])
  } finally {
    await context.close()
    await fixture.close()
    await fs.rm(userDataDir, { recursive: true, force: true })
  }
})
