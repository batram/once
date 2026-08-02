const { test, expect } = require("@playwright/test")
const {
  UNDO_SNACKBAR_VISIBLE_MS
} = require("../../../packages/ui-web/dist/story/undoSnackbarTiming")
const { openStoryMenu, seedFixtureStories } = require("./helpers/stories")
const {
  openSettingsSection,
  openSwipeAdvanced,
  waitForSwipeSettings
} = require("./helpers/settings")
const { dragStory } = require("./helpers/swipe")

// Mobile hides the row's read button, so the menu is how a read state is
// toggled without a swipe.
async function toggleReadFromMenu(page, story) {
  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-toggle-read").click()
}

// Releasing the drag is what commits the stage, so every skip here ends with an
// explicit pointerup rather than dragStory's own release.
async function swipeToSkip(page, story) {
  await dragStory(story, -110, { release: false })
  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
  await expect(story).toHaveClass(/skipped/)
}

test("a skip offers an undo that restores the row", async ({ page }) => {
  const story = await seedFixtureStories(page)
  const snackbar = page.getByTestId("undo-snackbar")
  await expect(snackbar).toBeHidden()

  await swipeToSkip(page, story)

  await expect(snackbar).toBeVisible()
  await expect(snackbar).toContainText("Skipped")
  await expect(snackbar).toContainText("Fixture article")

  await page.getByTestId("undo-snackbar-action").click()

  await expect(story).not.toHaveClass(/skipped/)
  await expect(snackbar).toBeHidden()
})

test("the offer expires on its own", async ({ page }) => {
  const story = await seedFixtureStories(page)

  await swipeToSkip(page, story)
  await expect(page.getByTestId("undo-snackbar")).toBeVisible()
  await expect(page.locator(".undo_snackbar_progress")).toHaveCSS(
    "animation-duration",
    `${UNDO_SNACKBAR_VISIBLE_MS / 1000}s`
  )

  // The row must stay skipped: letting the bar go is how the user accepts the
  // change. Keep runner slack separate from the product countdown duration.
  await expect(page.getByTestId("undo-snackbar")).toBeHidden({
    timeout: UNDO_SNACKBAR_VISIBLE_MS + 3000
  })
  await expect(story).toHaveClass(/skipped/)
})

test("the snackbar can be disabled in mobile settings", async ({ page }) => {
  const story = await seedFixtureStories(page)
  await openSettingsSection(page, "swipe")
  await openSwipeAdvanced(page)
  await page.locator("#swipe_undo_snackbar").uncheck()
  await waitForSwipeSettings(page)
  await page.getByTestId("stories-menu").click()

  await swipeToSkip(page, story)
  await expect(page.getByTestId("undo-snackbar")).toBeHidden()
})

// The mis-swipe this exists for arrives in runs, so a second change has to widen
// the same offer rather than replace it — otherwise undo reaches only the last
// row and the earlier ones are stranded.
test("consecutive changes coalesce and undo the whole run", async ({ page }) => {
  const story = await seedFixtureStories(page)
  const snackbar = page.getByTestId("undo-snackbar")

  await toggleReadFromMenu(page, story)
  await expect(story).toHaveClass(/skipped/)
  await expect(snackbar).toContainText("Skipped")

  await toggleReadFromMenu(page, story)
  await expect(story).not.toHaveClass(/skipped/)
  await expect(snackbar).toContainText("1 story updated")

  await page.getByTestId("undo-snackbar-action").click()
  // Both toggles reversed, not just the last one: the row returns to the unread
  // state it held before the run, rather than stopping at the skip in between.
  await expect(story).not.toHaveClass(/skipped/)
  await expect(snackbar).toBeHidden()
})
