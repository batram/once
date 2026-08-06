const { test, expect } = require("@playwright/test")
const { gotoMobileApp } = require("./helpers/mobile-app")
const {
  openSettingsSection,
  openSwipeAdvanced,
  setSwipeThreshold,
  waitForSwipeSettings
} = require("./helpers/settings")
const { seedFixtureStories } = require("./helpers/stories")
const { dragStory, translateX } = require("./helpers/swipe")

test("swipe settings autosave, undo, and reset without submit controls", async ({
  page
}) => {
  await gotoMobileApp(page)
  await openSettingsSection(page, "swipe")

  await expect(page.getByTestId("save-swipe")).toHaveCount(0)
  await expect(page.getByTestId("undo-swipe")).toBeDisabled()
  await page.getByTestId("swipe-right-1").selectOption("toggle-bookmark")
  await expect(page.getByTestId("swipe-save-status")).toHaveText("Saving…")
  await waitForSwipeSettings(page)
  await expect(page.getByTestId("undo-swipe")).toBeEnabled()

  await page.getByTestId("undo-swipe").click()
  await expect(page.getByTestId("swipe-right-1")).toHaveValue("open")
  await waitForSwipeSettings(page)
  await expect(page.getByTestId("undo-swipe")).toBeDisabled()

  await page.getByTestId("swipe-right-1").selectOption("skip")
  await waitForSwipeSettings(page)
  await page.getByTestId("reset-swipe").click()
  await expect(page.getByTestId("swipe-right-1")).toHaveValue("open")
  await waitForSwipeSettings(page)
  await page.getByTestId("undo-swipe").click()
  await expect(page.getByTestId("swipe-right-1")).toHaveValue("skip")
  await waitForSwipeSettings(page)
  await page.getByTestId("reset-swipe").click()
  await waitForSwipeSettings(page)
})

test("mobile undo snackbar settings autosave", async ({ page }) => {
  await gotoMobileApp(page)
  await openSettingsSection(page, "swipe")
  await openSwipeAdvanced(page)

  const enabled = page.locator("#swipe_undo_snackbar")
  const duration = page.locator("#swipe_undo_snackbar_duration")
  await expect(enabled).toBeVisible()
  await expect(enabled).toBeChecked()
  await expect(duration).toHaveValue("5000")

  await enabled.uncheck()
  await expect(duration).toBeDisabled()
  await waitForSwipeSettings(page)

  await enabled.check()
  await duration.fill("3000")
  await expect(duration.locator("xpath=following-sibling::output"))
    .toHaveText("3 s")
  await waitForSwipeSettings(page)
})

test("swipe settings fit the mobile viewport without horizontal clipping", async ({
  page
}) => {
  await gotoMobileApp(page)
  await openSettingsSection(page, "swipe")

  const measurements = await page.locator("#swipe_lab").evaluate((lab) => {
    const scroller = lab.querySelector(".swipe_lab_scroller")
    const inner = lab.querySelector(".swipe_lab_inner")
    return {
      labWidth: lab.getBoundingClientRect().width,
      scrollerClientWidth: scroller.clientWidth,
      scrollerScrollWidth: scroller.scrollWidth,
      innerWidth: inner.getBoundingClientRect().width
    }
  })
  expect(measurements.scrollerScrollWidth).toBe(measurements.scrollerClientWidth)
  expect(measurements.innerWidth).toBe(measurements.labWidth)
  const ruler = await page.getByTestId("swipe-ruler").boundingBox()
  const rightStage2 = await page.getByTestId("swipe-handle-right-2").boundingBox()
  const leftStage2 = await page.getByTestId("swipe-handle-left-2").boundingBox()
  expect(ruler).not.toBeNull()
  expect(rightStage2).not.toBeNull()
  expect(leftStage2).not.toBeNull()
  expect(rightStage2.x).toBeGreaterThanOrEqual(ruler.x)
  expect(leftStage2.x + leftStage2.width).toBeLessThanOrEqual(
    ruler.x + ruler.width
  )
  await expect(page.getByTestId("swipe-handle-right-2"))
    .toHaveAttribute("aria-valuenow", "200")
})

test("swipe settings retune action thresholds without a reload", async ({ page }) => {
  const story = await seedFixtureStories(page)

  await openSettingsSection(page, "swipe")
  await setSwipeThreshold(page, 1, 30)
  await page.getByTestId("swipe-right-1").selectOption("toggle-bookmark")
  await waitForSwipeSettings(page)
  await page.getByTestId("stories-menu").click()

  // 40px used to be below stage 1; with a 30px threshold it now engages.
  const retuned = await dragStory(story, 40, { release: false })
  expect(translateX(retuned.transform)).toBe(40)
  expect(retuned.label).toBe("Toggle bookmark")

  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
  await expect(story).toHaveClass(/stared/)
})

test("sticky stage strength controls the magnetic snap", async ({ page }) => {
  const story = await seedFixtureStories(page)

  await openSettingsSection(page, "swipe")
  await openSwipeAdvanced(page)
  await page.locator("#swipe_sticky_stages").check()
  await page.locator("#swipe_sticky_strength").fill("100")
  await waitForSwipeSettings(page)
  await page.getByTestId("stories-menu").click()

  // At full strength the default 56px threshold captures a swipe from 35px.
  const snapped = await dragStory(story, 35, { release: false })
  expect(translateX(snapped.transform)).toBe(56)
  expect(snapped.action).toBe("open")
  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }))
  })

  // Even at full strength, movement outside the 50px capture band is free.
  const free = await dragStory(story, 120, { release: false })
  expect(translateX(free.transform)).toBe(120)
  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }))
  })

  await openSettingsSection(page, "swipe")
  await openSwipeAdvanced(page)
  await page.locator("#swipe_sticky_strength").fill("1")
  await waitForSwipeSettings(page)
  await page.getByTestId("stories-menu").click()

  // The same 35px gesture is outside the low-strength capture band.
  const subtle = await dragStory(story, 35, { release: false })
  expect(translateX(subtle.transform)).toBe(35)
  expect(subtle.action).toBe("none")
  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }))
  })
})

test("the swipe settings sample row tries unsaved values and commits nothing", async ({ page }) => {
  const story = await seedFixtureStories(page)
  await openSettingsSection(page, "swipe")

  // Edited but deliberately NOT saved: the sample row reads the form.
  await setSwipeThreshold(page, 1, 30)
  await page.getByTestId("swipe-right-1").selectOption("toggle-bookmark")

  const preview = page.getByTestId("swipe-preview-row")
  const dragged = await dragStory(preview, 40, { release: false })
  expect(translateX(dragged.transform)).toBe(40)
  expect(dragged.label).toBe("Toggle bookmark")

  await preview.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
  await expect(page.getByTestId("swipe-preview-status"))
    .toHaveText("Stage 1 → Toggle bookmark")

  // The unsaved edit reached the sample only: real rows still use the stored
  // thresholds, where 40px is below stage 1.
  await page.getByTestId("stories-menu").click()
  const real = await dragStory(story, 40)
  expect(translateX(real.transform)).toBe(40)
  expect(real.label).toBe("Read · open")
  expect(real.action).toBe("none")
  await expect(story).not.toHaveClass(/stared/)
})

test("turning off two-stage swipe keeps the gesture on stage one", async ({ page }) => {
  const story = await seedFixtureStories(page)

  await openSettingsSection(page, "swipe")
  await openSwipeAdvanced(page)
  await page.locator("#swipe_two_stage").uncheck()
  await expect(page.getByTestId("swipe-handle-right-2")).toBeDisabled()
  await expect(page.getByTestId("swipe-handle-left-2")).toBeDisabled()
  await waitForSwipeSettings(page)
  await page.getByTestId("stories-menu").click()

  // A drag well past the old stage-2 threshold stays on stage 1.
  const long = await dragStory(story, 400, { release: false })
  expect(translateX(long.transform)).toBe(400)
  expect(long.action).toBe("open")

  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
})
