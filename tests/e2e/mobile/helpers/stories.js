const { expect } = require("@playwright/test")
const {
  gotoMobileApp,
  reloadMobileApp,
  testServerUrl
} = require("./mobile-app")
const { openSettingsSection, saveSourcesAndWait } = require("./settings")

// Long-press anywhere on the row; ⋮ opens the same menu at the same anchor.
async function openStoryMenu(page, story) {
  // Held until the menu is there, not for a fixed time: the app opens it from a
  // timer, and a fixed hold can end before a busy page has run it.
  await story.hover()
  await page.mouse.down()
  await expect(page.getByTestId("story-menu")).toBeVisible()
  // The release click is the last event of the press and disarms the app's
  // long-press click suppressor, so the next tap is not swallowed.
  await page.mouse.up()
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
