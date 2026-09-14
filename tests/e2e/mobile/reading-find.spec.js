const { test, expect } = require("@playwright/test")
const { seedFixtureStories } = require("./helpers/stories")
const { triggerMobileBack } = require("./helpers/mobile-app")

// The fixture article repeats one paragraph eight times, so a word from it
// has exactly eight matches. Reader mode is the searchable mode in the web
// harness: browser mode hands the page to an external browser there. The
// browser ⋮ sheet that offers "Find" is native, so the harness raises the
// request the sheet's Find control would.
test("Find in page searches the reader document", async ({ page }) => {
  const story = await seedFixtureStories(page)
  await story.getByTestId("story-menu-button").tap()
  await page.getByTestId("story-menu-open-reader").tap()
  await expect(page.locator("#reading_content")).toHaveAttribute("data-mode", "reader")
  await expect(page.getByTestId("reading-reader-status")).toBeHidden()

  const bar = page.getByTestId("reading-find-bar")
  const count = page.getByTestId("reading-find-count")
  await expect(bar).toBeHidden()
  await page.evaluate(() => document.dispatchEvent(new Event("once-find-in-page-request")))
  await expect(bar).toBeVisible()
  await expect(page.getByTestId("reading-find-input")).toBeFocused()

  await page.keyboard.type("deterministic")
  await expect(count).toHaveText("1/8")
  await page.keyboard.press("Enter")
  await expect(count).toHaveText("2/8")
  await page.locator("#reading_find_prev").tap()
  await expect(count).toHaveText("1/8")
  await page.locator("#reading_find_prev").tap()
  await expect(count).toHaveText("8/8", "stepping back from the first match wraps")
  // The arrow buttons take focus, so the keyboard stays down while stepping;
  // editing the query means tapping the field again.
  await page.getByTestId("reading-find-input").tap()
  await page.keyboard.press("End")
  await page.keyboard.type("x")
  await expect(count).toHaveText("No matches")

  // The Android back gesture closes the bar before it leaves the reading view.
  await triggerMobileBack(page)
  await expect(bar).toBeHidden()
  await expect(page.locator("#reading_content")).toBeVisible()
})
