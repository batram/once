const { expect } = require("@playwright/test")
const {
  gotoMobileApp,
  reloadMobileApp,
  testServerUrl
} = require("./mobile-app")
const { openSettingsSection, saveSourcesAndWait } = require("./settings")

// Long-press anywhere on the row; ⋮ opens the same menu at the same anchor.
async function openStoryMenu(page, story) {
  await story.click({ delay: 700 })
  await expect(page.getByTestId("story-menu")).toBeVisible()
  // The app suppresses the synthetic release click from a long-press for up
  // to 250ms. Do not let the harness's next intentional tap get swallowed.
  await page.waitForTimeout(300)
}

// Points the app at the local fixture feed, reloads so the source is the stored
// one, and returns the single fixture story row.
async function seedFixtureStories(page) {
  await gotoMobileApp(page)
  await openSettingsSection(page, "sources")
  await page.getByTestId("sources").fill(
    await testServerUrl(page, "/fixtures/feed.rss")
  )
  await saveSourcesAndWait(page)
  await reloadMobileApp(page)
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()
  const story = page.getByTestId("story").filter({ hasText: "Fixture article" })
  await expect(story).toBeVisible()
  return story
}

module.exports = { openStoryMenu, seedFixtureStories }
