const { test, expect } = require("@playwright/test")
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

async function holdButton(page, button) {
  const box = await button.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(700)
  await page.mouse.up()
}

test("the undo button is always there and dims until there is something to undo", async ({ page }) => {
  const story = await seedFixtureStories(page)
  const button = page.getByTestId("undo-button")
  await expect(button).toBeVisible()
  await expect(button).toHaveAttribute("aria-disabled", "true")

  await swipeToSkip(page, story)
  await expect(button).toHaveAttribute("aria-disabled", "false")

  await button.click()
  await expect(story).not.toHaveClass(/skipped/)
  await expect(button).toHaveAttribute("aria-disabled", "true")
  // Nothing expires: the button stays put after the undo, too.
  await expect(button).toBeVisible()
})

test("a tap undoes one change at a time", async ({ page }) => {
  const story = await seedFixtureStories(page)
  const button = page.getByTestId("undo-button")

  await toggleReadFromMenu(page, story)
  await expect(story).toHaveClass(/skipped/)
  await toggleReadFromMenu(page, story)
  await expect(story).not.toHaveClass(/skipped/)

  await button.click()
  await expect(story).toHaveClass(/skipped/)
  await expect(button).toHaveAttribute("aria-disabled", "false")

  await button.click()
  await expect(story).not.toHaveClass(/skipped/)
  await expect(button).toHaveAttribute("aria-disabled", "true")
})

test("holding the button lists changes and undoes only the picked one", async ({ page }) => {
  const story = await seedFixtureStories(page)
  const button = page.getByTestId("undo-button")

  await holdButton(page, button)
  await expect(page.getByTestId("undo-list-empty")).toBeVisible()
  await page.getByTestId("story-menu-backdrop").dispatchEvent("pointerdown")

  await swipeToSkip(page, story)
  await holdButton(page, button)
  const items = page.getByTestId("undo-list-item")
  await expect(items).toHaveCount(1)
  await expect(items.first()).toContainText("Skipped")
  await expect(items.first()).toContainText("Fixture article")
  // The release after the hold must not have undone anything by itself.
  await expect(story).toHaveClass(/skipped/)

  await items.first().click()
  await expect(story).not.toHaveClass(/skipped/)
  await expect(button).toHaveAttribute("aria-disabled", "true")
})

test("the undo button can be hidden in mobile settings", async ({ page }) => {
  await seedFixtureStories(page)
  await openSettingsSection(page, "swipe")
  await openSwipeAdvanced(page)
  await page.locator("#swipe_undo_button").uncheck()
  await waitForSwipeSettings(page)
  await page.getByTestId("stories-menu").click()

  await expect(page.getByTestId("undo-button")).toBeHidden()
})
