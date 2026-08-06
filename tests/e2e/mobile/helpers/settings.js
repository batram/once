const { expect } = require("@playwright/test")
const { waitForMobileApp } = require("./mobile-app")

async function openSettingsSection(page, section) {
  await waitForMobileApp(page)
  await page.getByTestId("settings-menu").click()
  const row = page.locator(`[data-settings-target="${section}"]`)
  if (!(await row.isVisible())) {
    const back = page.locator("#settings_section_back")
    if (await back.isVisible()) await back.click()
  }
  await row.click()
  if (["sources", "filters", "redirects"].includes(section)) {
    const textarea = page.getByTestId(
      section === "sources" ? "sources" : section
    )
    if (!(await textarea.isVisible())) {
      await page.getByTestId(`${section}-mode-toggle`).click()
    }
  }
}

async function saveSourcesAndWait(page) {
  const save = page.getByTestId("save-sources")
  await save.click()
  await expect(save).toBeEnabled()
}

/**
 * Reorder by dropping into the lower half of the target row. A row's midpoint
 * decides insert-before from insert-after, so dragTo's default centre landing
 * is ambiguous and rounds to "before" — which, for the row directly above, is
 * a no-op rather than a move.
 */
async function dragBelowMidpoint(source, target) {
  // nth() re-resolves on every call, so a save still re-rendering the list can
  // hand back a node that is detached by the time it is measured. Retry until
  // the list has settled.
  let box = null
  await expect.poll(async () => {
    box = await target.boundingBox()
    return box !== null
  }).toBe(true)
  await source.dragTo(target, {
    targetPosition: { x: box.width / 2, y: box.height * 0.75 }
  })
}

async function setSwipeThreshold(page, stage, value) {
  const handle = page.getByTestId(`swipe-handle-right-${stage}`)
  await expect(handle).toHaveAttribute("aria-valuemin", /\d+/)
  const minimumAttribute = await handle.getAttribute("aria-valuemin")
  if (minimumAttribute === null) {
    throw new Error("Swipe threshold minimum is not rendered")
  }
  await handle.press("Home")
  await expect(handle).toHaveAttribute("aria-valuenow", minimumAttribute)
  const minimum = Number(await handle.getAttribute("aria-valuenow"))
  if (!Number.isFinite(minimum) || value < minimum) {
    throw new Error(`Swipe threshold ${value} is below the minimum ${minimum}`)
  }
  const tens = Math.floor((value - minimum) / 10)
  const ones = value - minimum - tens * 10
  let current = minimum
  for (let index = 0; index < tens; index += 1) {
    await handle.press("Shift+ArrowRight")
    current += 10
    await expect(handle).toHaveAttribute("aria-valuenow", String(current))
  }
  for (let index = 0; index < ones; index += 1) {
    await handle.press("ArrowRight")
    current += 1
    await expect(handle).toHaveAttribute("aria-valuenow", String(current))
  }
}

async function openSwipeAdvanced(page) {
  const details = page.getByTestId("swipe-advanced")
  if (!(await details.evaluate((element) => element.open))) {
    await details.locator("summary").click()
  }
}

async function waitForSwipeSettings(page) {
  await expect(page.getByTestId("swipe-save-status"))
    .toHaveText("Saved")
}

module.exports = {
  openSettingsSection,
  saveSourcesAndWait,
  dragBelowMidpoint,
  setSwipeThreshold,
  openSwipeAdvanced,
  waitForSwipeSettings
}
