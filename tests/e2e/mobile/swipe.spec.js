const { test, expect } = require("@playwright/test")
const {
  openSettingsSection,
  setSwipeThreshold,
  waitForSwipeSettings
} = require("./helpers/settings")
const { seedFixtureStories } = require("./helpers/stories")
const { dragStory, translateX } = require("./helpers/swipe")

test("swipe labels become bold only after a stage threshold is active", async ({ page }) => {
  const story = await seedFixtureStories(page)

  const preview = await dragStory(story, 30, { release: false })
  expect(preview.label).toBe("Read · open")
  expect(preview.action).toBe("none")
  expect(preview.labelWeight).toBe("400")

  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }))
  })

  const active = await dragStory(story, 70, { release: false })
  expect(active.action).toBe("open")
  expect(active.labelWeight).toBe("600")

  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }))
  })
})

test("swipe follows the finger and commits the stage it was released on", async ({ page }) => {
  const story = await seedFixtureStories(page)

  // Below stage 1: the row follows the finger and previews the first action,
  // but releasing still fires nothing.
  const belowStage1 = await dragStory(story, 40)
  expect(translateX(belowStage1.transform)).toBe(40)
  expect(belowStage1.label).toBe("Read · open")
  expect(belowStage1.action).toBe("none")
  await expect(story).not.toHaveClass(/\bread\b/)

  // Stage 1 left remains under the finger and skips on release.
  const stage1Left = await dragStory(story, -110, { release: false })
  expect(translateX(stage1Left.transform)).toBe(-110)
  expect(stage1Left.labelRight).toBe("Skip")
  expect(stage1Left.action).toBe("skip")
  await page.locator("story-item").first().evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
  await expect(story).toHaveClass(/skipped/)
})

test("the default open swipe uses the in-app reading view", async ({ page }) => {
  const story = await seedFixtureStories(page)

  const stage1Right = await dragStory(story, 110, { release: false })
  expect(translateX(stage1Right.transform)).toBe(110)
  expect(stage1Right.label).toBe("Read · open")
  expect(stage1Right.action).toBe("open")
  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })

  await expect(page.locator("#reading_content")).toHaveAttribute(
    "data-mode",
    "browser"
  )
  await expect(page.locator("#left_panel")).toHaveAttribute(
    "active_panel",
    "reading"
  )
})

// The gesture is measured from where the finger went down, not from the first
// move the swipe handler happens to see — that one arrives only after the axis
// lock resolves, and a flick has covered most of its distance by then.
test("a flick that clears stage 1 in one move still commits stage 1", async ({ page }) => {
  const story = await seedFixtureStories(page)

  const flick = await dragStory(story, -110, { release: false, moves: [1] })
  expect(translateX(flick.transform)).toBe(-110)
  expect(flick.action).toBe("skip")

  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
  await expect(story).toHaveClass(/skipped/)
})

test("a swipe beyond its threshold stays under the finger", async ({ page }) => {
  const story = await seedFixtureStories(page)

  await openSettingsSection(page, "swipe")
  await setSwipeThreshold(page, 1, 100)
  await waitForSwipeSettings(page)
  await page.getByTestId("stories-menu").click()

  const shallow = await dragStory(story, -130, { release: false })
  expect(translateX(shallow.transform)).toBe(-130)
  expect(shallow.action).toBe("skip")

  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
  await expect(story).toHaveClass(/skipped/)
})

test("swipe follows the finger while escalating to stage two", async ({ page }) => {
  const story = await seedFixtureStories(page)

  const stage2 = await dragStory(story, 400, { release: false })
  expect(translateX(stage2.transform)).toBe(400)
  expect(stage2.label).toBe("Open in reader")
  expect(stage2.action).toBe("open-reader")

  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
  await expect(page.locator("#reading_content")).toHaveAttribute("data-mode", "reader")
})
