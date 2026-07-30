const { test, expect } = require("@playwright/test")
const { openSettingsSection, openSwipeAdvanced } = require("./helpers/settings")
const { seedFixtureStories } = require("./helpers/stories")
const { dragStory, sampleSwipePhases, translateX } = require("./helpers/swipe")

test("fast swipe mode requires stage two to lock before it commits", async ({ page }) => {
  await seedFixtureStories(page)
  await openSettingsSection(page, "swipe")
  await openSwipeAdvanced(page)
  await page.locator("#swipe_fast_mode").check()
  await page.locator("#swipe_stage_2_lock_in").fill("175")

  const preview = page.getByTestId("swipe-preview-row")

  // Strong magnetic attraction may display the row at the 200px stage-two
  // threshold, but raw travel below it must neither preview nor start locking.
  await page.locator("#swipe_sticky_stages").check()
  await page.locator("#swipe_sticky_strength").fill("100")
  const magnetized = await dragStory(preview, 160, { release: false })
  expect(translateX(magnetized.transform)).toBeGreaterThan(160)
  expect(magnetized.action).toBe("open")
  await expect(page.locator('.bb_slide [data-lock="pending"]')).toHaveCount(0)
  await preview.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }))
  })

  // A quick pass stays visually truthful: Stage 1 is the only promise shown
  // and is also the action committed on release.
  const quick = await preview.evaluate((row) => {
    const rect = row.getBoundingClientRect()
    const y = rect.top + rect.height / 2
    const startX = rect.left + 40
    const touch = (x) =>
      new Touch({ identifier: 9, target: row, clientX: x, clientY: y })
    const fire = (type, x) => {
      row.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: type === "touchend" ? [] : [touch(x)],
          changedTouches: [touch(x)]
        })
      )
    }
    fire("touchstart", startX)
    fire("touchmove", startX + 400)
    const revealed = document.querySelector(".bb_slide .swipe_left")
    const result = {
      action: revealed?.dataset.action,
      phase: revealed?.dataset.lockPhase,
      primary:
        revealed?.querySelector(".swipe_action_primary")?.textContent,
      secondary:
        revealed?.querySelector(".swipe_action_secondary")?.textContent
    }
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
    return result
  })
  expect(quick).toEqual({
    action: "open",
    phase: "quiet",
    primary: "Read · open",
    secondary: ""
  })
  await expect(page.getByTestId("swipe-preview-status"))
    .toHaveText("Stage 1 → Read · open")

  const quickLeft = await preview.evaluate((row) => {
    const rect = row.getBoundingClientRect()
    const y = rect.top + rect.height / 2
    const startX = rect.right - 40
    const touch = (x) =>
      new Touch({ identifier: 10, target: row, clientX: x, clientY: y })
    const fire = (type, x) => {
      row.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: type === "touchend" ? [] : [touch(x)],
          changedTouches: [touch(x)]
        })
      )
    }
    fire("touchstart", startX)
    fire("touchmove", startX - 400)
    const revealed = document.querySelector(".bb_slide .swipe_right")
    const result = {
      action: revealed?.dataset.action,
      phase: revealed?.dataset.lockPhase,
      primary:
        revealed?.querySelector(".swipe_action_primary")?.textContent,
      secondary:
        revealed?.querySelector(".swipe_action_secondary")?.textContent
    }
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
    return result
  })
  expect(quickLeft).toEqual({
    action: "skip",
    phase: "quiet",
    primary: "Skip",
    secondary: ""
  })
  await expect(page.getByTestId("swipe-preview-status"))
    .toHaveText("Stage 1 → Skip")

  // A deliberate hold explains the destination without changing the action
  // currently promised by the primary label and background.
  await dragStory(preview, 400, { release: false })
  await expect(page.locator('[data-lock-phase="handoff"]')).toBeVisible()
  const handoff = page.locator('.bb_slide .swipe_left[data-lock="pending"]')
  await expect(handoff).toHaveAttribute("data-action", "open")
  await expect(handoff.locator(".swipe_action_primary")).toHaveText("Read · open")
  await expect(handoff.locator(".swipe_action_secondary"))
    .toHaveText("Hold → Open in reader")

  // Holding continuously beyond the threshold arms and commits stage two.
  await expect(page.locator('.bb_slide [data-lock="armed"]')).toBeVisible()
  const armed = page.locator('.bb_slide .swipe_left[data-lock="armed"]')
  await expect(armed).toHaveAttribute("data-action", "open-reader")
  await expect(armed.locator(".swipe_action_primary")).toHaveText("Open in reader")
  await expect(armed.locator(".swipe_action_secondary")).toHaveText("")
  await preview.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
  await expect(page.getByTestId("swipe-preview-status"))
    .toHaveText("Stage 2 → Open in reader")
})

test("fast swipe handoff respects lock-in extremes and identical actions", async ({
  page
}) => {
  await seedFixtureStories(page)
  await openSettingsSection(page, "swipe")
  await openSwipeAdvanced(page)
  await page.locator("#swipe_fast_mode").check()
  const preview = page.getByTestId("swipe-preview-row")

  // At the minimum delay the entire pending interval is quiet, followed by a
  // direct switch to the armed Stage 2 surface.
  await page.locator("#swipe_stage_2_lock_in").fill("75")
  const minimum = await sampleSwipePhases(preview, 400, [35, 60])
  expect(minimum[0]).toMatchObject({
    action: "open",
    lock: "pending",
    phase: "quiet",
    primary: "Read · open",
    secondary: ""
  })
  expect(minimum[1]).toMatchObject({
    action: "open-reader",
    lock: "armed",
    phase: "none",
    primary: "Open in reader",
    secondary: ""
  })

  // The maximum delay still uses a 75ms quiet phase; the remaining 425ms is
  // exposed to CSS as the explanatory handoff duration.
  await page.locator("#swipe_stage_2_lock_in").fill("500")
  const maximum = await sampleSwipePhases(preview, 400, [100])
  expect(maximum[0]).toMatchObject({
    action: "open",
    lock: "pending",
    phase: "handoff",
    primary: "Read · open",
    secondary: "Hold → Open in reader",
    handoffDuration: "425ms"
  })

  // There is no explanatory label when holding would produce the same action.
  await page.getByTestId("swipe-right-2").selectOption("open")
  const identical = await sampleSwipePhases(preview, 400, [100])
  expect(identical[0]).toMatchObject({
    action: "open",
    lock: "pending",
    phase: "quiet",
    primary: "Read · open",
    secondary: ""
  })
})

test("leaving protected stage two resets its lock-in period", async ({ page }) => {
  await seedFixtureStories(page)
  await openSettingsSection(page, "swipe")
  await openSwipeAdvanced(page)
  await page.locator("#swipe_fast_mode").check()
  await page.locator("#swipe_stage_2_lock_in").fill("175")
  const preview = page.getByTestId("swipe-preview-row")

  await preview.evaluate(async (row) => {
    const rect = row.getBoundingClientRect()
    const y = rect.top + rect.height / 2
    const startX = rect.left + 40
    const touch = (x) =>
      new Touch({ identifier: 8, target: row, clientX: x, clientY: y })
    const move = (distance) => {
      row.dispatchEvent(
        new TouchEvent("touchmove", {
          bubbles: true,
          cancelable: true,
          touches: [touch(startX + distance)],
          changedTouches: [touch(startX + distance)]
        })
      )
    }
    row.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [touch(startX)],
        changedTouches: [touch(startX)]
      })
    )
    move(400)
    await new Promise((resolve) => setTimeout(resolve, 100))
    move(150)
  })
  await expect(page.locator('.bb_slide [data-stage="1"]')).toBeVisible()
  await expect(
    page.locator('.bb_slide [data-stage="1"] .swipe_action_secondary')
  ).toHaveText("")
  await expect(page.locator('.bb_slide [data-lock="armed"]')).toHaveCount(0)
  await preview.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
  await expect(page.getByTestId("swipe-preview-status"))
    .toHaveText("Stage 1 → Read · open")

  // Retreating after Stage 2 has armed also restores Stage 1 immediately.
  await preview.evaluate(async (row) => {
    const rect = row.getBoundingClientRect()
    const y = rect.top + rect.height / 2
    const startX = rect.left + 40
    const touch = (x) =>
      new Touch({ identifier: 12, target: row, clientX: x, clientY: y })
    const move = (distance) => {
      row.dispatchEvent(
        new TouchEvent("touchmove", {
          bubbles: true,
          cancelable: true,
          touches: [touch(startX + distance)],
          changedTouches: [touch(startX + distance)]
        })
      )
    }
    row.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [touch(startX)],
        changedTouches: [touch(startX)]
      })
    )
    move(400)
    await new Promise((resolve) => setTimeout(resolve, 200))
    move(150)
  })
  await expect(page.locator('.bb_slide [data-stage="1"]')).toBeVisible()
  await expect(page.locator('.bb_slide [data-lock="armed"]')).toHaveCount(0)

  // Re-entry starts from pending rather than retaining the previous lock.
  await preview.evaluate((row) => {
    const rect = row.getBoundingClientRect()
    const y = rect.top + rect.height / 2
    // The current rect already includes the 150px transform.
    const x = rect.left + 290
    const touch = new Touch({
      identifier: 8,
      target: row,
      clientX: x,
      clientY: y
    })
    row.dispatchEvent(
      new TouchEvent("touchmove", {
        bubbles: true,
        cancelable: true,
        touches: [touch],
        changedTouches: [touch]
      })
    )
  })
  await expect(page.locator('.bb_slide [data-lock="pending"]')).toBeVisible()
  await preview.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
  await expect(page.getByTestId("swipe-preview-status"))
    .toHaveText("Stage 1 → Read · open")
})
