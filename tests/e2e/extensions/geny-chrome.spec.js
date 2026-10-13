const {
  expect,
  expectExtensionReady,
  test,
  waitForExtensionWorker
} = require("../shared/browser-evidence")
const { launchExtensionChrome } = require("../shared/extension-chrome")
const {
  STORY_TITLE,
  startGenyFixture
} = require("../shared/geny-fixture")

test("Chrome genymatch extracts innerText from fetched HTML", async () => {
  const fixture = await startGenyFixture()
  const browser = await launchExtensionChrome({ profilePrefix: "once-chrome-geny-" }).catch(async (error) => {
    await fixture.close()
    throw error
  })
  const { context, evidence } = browser
  const pageErrors = evidence.pageErrors
  try {
    await context.route(/^https?:/, async (route) => {
      if (route.request().url().startsWith(fixture.origin)) {
        await route.continue()
      } else {
        await route.abort()
      }
    })
    const worker = await waitForExtensionWorker(context)
    const extensionId = new URL(worker.url()).host
    const page = await context.newPage()
    await page.goto(
      `chrome-extension://${extensionId}/static/sidepanel.html?once-e2e=1`
    )
    await expectExtensionReady(page, evidence)

    await page.getByTestId("settings-menu").click()
    await page.locator('[data-settings-target="sources"]').click()
    await page.getByTestId("sources-mode-toggle").click()
    await page.getByTestId("sources").fill(fixture.source)
    await page.getByTestId("save-sources").click()
    await page.getByTestId("stories-menu").click()
    await page.locator("#searchfield").fill("")

    const story = page.locator(
      `story-item[data-href="${fixture.storyUrl}"]`
    )
    await expect(story).toBeVisible()
    await expect(story.locator("a.title")).toHaveText(STORY_TITLE)
    await expect(story).toContainText("TypeScript")
    expect(pageErrors).toEqual([])
  } finally {
    await browser.close(() => fixture.close())
  }
})
