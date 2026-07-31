const { test, expect } = require("@playwright/test")
const { openStoryMenu, seedFixtureStories } = require("./helpers/stories")
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

  // Outlives the 5s countdown. The row must stay skipped: letting the bar go is
  // how the user accepts the change.
  await expect(page.getByTestId("undo-snackbar")).toBeHidden({ timeout: 8000 })
  await expect(story).toHaveClass(/skipped/)
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
