const { test, expect } = require("@playwright/test")
const { gotoMobileApp } = require("./helpers/mobile-app")
const {
  openSettingsSection,
  saveSourcesAndWait
} = require("./helpers/settings")
const {
  dragAcross,
  startDrag,
  endDrag,
  touchStart,
  touchMove,
  touchEnd
} = require("./helpers/gestures")

// Three groups: the implicit Default holding one source, then Alpha and Beta
// each holding one. The Default group is not user-created, so it has neither a
// drag handle nor a menu.
async function seedGroupedSources(page) {
  await gotoMobileApp(page)
  await openSettingsSection(page, "sources")
  const fixture = new URL("/fixtures/feed.rss", page.url()).href
  await page.getByTestId("sources").fill([
    fixture,
    "*Alpha",
    `${fixture}?group=alpha`,
    "*Beta",
    `${fixture}?group=beta`
  ].join("\n"))
  await saveSourcesAndWait(page)
  await page.getByTestId("sources-mode-toggle").click()
  const groups = page.locator(".structured_group")
  await expect(groups).toHaveCount(3)
  return { fixture, groups }
}

test("story source groups align with the settings panel and expose their handles", async ({
  page
}) => {
  const { groups } = await seedGroupedSources(page)

  const alignment = await page.evaluate(() => {
    const bounds = (selector) =>
      document.querySelector(selector)?.getBoundingClientRect()
    const back = bounds("#settings_section_back")
    const title = bounds("#settings_panel .settings_title")
    const search = bounds(
      '[data-structured-section="sources"] .structured_search input'
    )
    const group = bounds(
      '[data-structured-section="sources"] .structured_group'
    )
    const toggle = bounds("[data-testid='sources-mode-toggle']")
    const scroller = bounds("[data-structured-section='sources']")
    return {
      viewportWidth: window.innerWidth,
      backLeft: back?.left,
      backRight: back?.right,
      backCenterY: back && back.top + back.height / 2,
      titleLeft: title?.left,
      titleCenterY: title && title.top + title.height / 2,
      searchLeft: search?.left,
      searchRight: search?.right,
      groupLeft: group?.left,
      groupRight: group?.right,
      toggleRight: toggle?.right,
      scrollerRight: scroller?.right
    }
  })
  expect(alignment.backLeft).toBe(16)
  expect(alignment.titleLeft - alignment.backRight).toBe(8)
  expect(alignment.searchLeft).toBe(16)
  expect(alignment.groupLeft).toBe(16)
  expect(alignment.searchRight).toBe(alignment.viewportWidth - 16)
  expect(alignment.groupRight).toBe(alignment.viewportWidth - 16)
  expect(alignment.toggleRight).toBe(alignment.viewportWidth - 16)
  expect(alignment.scrollerRight).toBe(alignment.viewportWidth)
  expect(Math.abs(alignment.backCenterY - alignment.titleCenterY))
    .toBeLessThan(1)

  await expect(page.locator(".structured_group_drag_handle")).toHaveCount(2)
  await expect(groups.nth(0).locator(".structured_group_drag_handle"))
    .toHaveCount(0)
  await expect(groups.nth(0).locator(".structured_group_menu")).toHaveCount(0)
  await expect(groups.nth(0).locator(".structured_group_menu_spacer"))
    .toHaveCount(1)
  await expect(groups.nth(1).locator(".structured_group_menu"))
    .toHaveCSS("opacity", "1")
  await expect(groups.nth(2).locator(".structured_group_menu"))
    .toHaveCSS("opacity", "1")
  await expect(page.locator(".structured_source_drag_handle")).toHaveCount(3)

  const groupHeaderMetrics = await groups.evaluateAll((entries) =>
    entries.map((group) => {
      const count = group.querySelector(".structured_group_count")
      const summary = group.querySelector("summary")
      return {
        countRight: count?.getBoundingClientRect().right || 0,
        touchAction: summary ? getComputedStyle(summary).touchAction : ""
      }
    }))
  expect(groupHeaderMetrics[1].touchAction).toBe("pan-y")
  expect(groupHeaderMetrics[2].touchAction).toBe("pan-y")
  expect(Math.abs(
    groupHeaderMetrics[0].countRight - groupHeaderMetrics[1].countRight
  )).toBeLessThan(1)

  await groups.nth(0).locator(".structured_row_chevron").click()
  await expect(page.getByTestId("structured-item-form")).toBeVisible()
  await page.getByRole("button", { name: "Cancel" }).click()
  await expect(page.getByTestId("structured-item-form")).toBeHidden()
})

test("dragging a source previews its drop position in another group", async ({
  page
}) => {
  const { groups } = await seedGroupedSources(page)
  const defaultSource = groups.nth(0).locator(".structured_row")
  const alphaSource = groups.nth(1).locator(".structured_row")

  // Android reports movement on the held row. Its own one-row group is a
  // no-op destination and must not advertise a misleading append position.
  await dragAcross(defaultSource, defaultSource, { on: "source", edge: "bottom" })
  await expect(page.locator(
    ".structured_source_group_drop_target," +
    " .structured_source_group_title_drop_target"
  )).toHaveCount(0)

  await dragAcross(defaultSource, alphaSource, { on: "source", edge: "top" })
  await expect(alphaSource).toHaveClass(/\bstructured_source_drop_before\b/)

  await dragAcross(defaultSource, alphaSource, { on: "target", edge: "bottom" })
  await expect(alphaSource).toHaveClass(/\bstructured_source_drop_after\b/)

  await endDrag(defaultSource)
  await expect(alphaSource).not.toHaveClass(/\bstructured_source_drop_before\b/)
  await expect(alphaSource).not.toHaveClass(/\bstructured_source_drop_after\b/)
})

test("story source groups collapse while dragging and restore afterward", async ({
  page
}) => {
  const { fixture, groups } = await seedGroupedSources(page)

  await groups.nth(1).locator(".structured_group_name").click()
  await expect(groups.nth(1)).not.toHaveAttribute("open", "")
  await expect(groups.nth(0)).toHaveAttribute("open", "")
  await expect(groups.nth(2)).toHaveAttribute("open", "")

  // Dragging any group collapses them all so the drop targets stay reachable,
  // and the collapse state each group had before the drag is restored after.
  const betaName = groups.nth(2).locator(".structured_group_name")
  await startDrag(betaName)
  await expect(page.getByTestId("sources-structured-list"))
    .toHaveClass(/\bstructured_group_drag_active\b/)
  await expect(groups.locator(".structured_rows").first()).toBeHidden()
  await expect(groups.nth(0)).toHaveAttribute("open", "")
  await expect(groups.nth(1)).not.toHaveAttribute("open", "")
  await expect(groups.nth(2)).toHaveAttribute("open", "")

  await endDrag(betaName)
  await expect(groups.nth(0)).toHaveAttribute("open", "")
  await expect(groups.nth(1)).not.toHaveAttribute("open", "")
  await expect(groups.nth(2)).toHaveAttribute("open", "")

  // A short move on a group header scrolls the list. Only a held press turns
  // into a drag, so this one must be left unclaimed.
  const alphaSummary = groups.nth(1).locator("summary")
  const alphaScrollBounds = await alphaSummary.boundingBox()
  expect(alphaScrollBounds).not.toBeNull()
  const scrollY = alphaScrollBounds.y + alphaScrollBounds.height / 2
  await touchStart(alphaSummary, { touchId: 16, clientY: scrollY })
  expect(await touchMove(alphaSummary, { touchId: 16, clientY: scrollY + 10 }))
    .toBe(false)
  await expect(page.getByTestId("sources-structured-list"))
    .not.toHaveClass(/\bstructured_group_drag_active\b/)

  const betaBounds = await betaName.boundingBox()
  expect(betaBounds).not.toBeNull()
  const betaGroupBounds = await groups.nth(2).boundingBox()
  expect(betaGroupBounds).not.toBeNull()
  const betaSummary = groups.nth(2).locator("summary")
  const touchId = 17
  const betaStartY = betaBounds.y + betaBounds.height / 2
  // The whole title bar is the touch handle, not only the group name.
  await touchStart(groups.nth(2).locator(".structured_group_count"), {
    touchId,
    clientY: betaStartY
  })
  await page.waitForTimeout(350)
  await expect(page.getByTestId("sources-structured-list"))
    .toHaveClass(/\bstructured_group_drag_active\b/)
  await expect(groups.nth(2)).toHaveClass(/\bstructured_group_dragging\b/)
  await expect(groups.nth(1)).toHaveClass(/\bstructured_group_drop_after\b/)

  const defaultBounds = await groups.nth(0).locator("summary").boundingBox()
  expect(defaultBounds).not.toBeNull()
  expect(await touchMove(betaSummary, {
    touchId,
    clientY: defaultBounds.y + 1
  })).toBe(true)
  await expect(groups.nth(0)).toHaveClass(/\bstructured_group_drop_after\b/)
  await expect(groups.nth(0)).not.toHaveClass(/\bstructured_group_drop_before\b/)

  const alphaBounds = await groups.nth(1).locator("summary").boundingBox()
  expect(alphaBounds).not.toBeNull()
  expect(await touchMove(betaSummary, {
    touchId,
    clientY: alphaBounds.y + 2
  })).toBe(true)
  await expect(groups.nth(1)).toHaveClass(/\bstructured_group_drop_before\b/)

  // The held group tracks the finger, keeping the point it was grabbed by
  // under the touch rather than snapping to the pointer.
  const draggedTransform = await groups.nth(2).evaluate((group) =>
    getComputedStyle(group).transform)
  expect(draggedTransform).not.toBe("none")
  const heldPointY = await groups.nth(2).evaluate((group, grabOffset) =>
    group.getBoundingClientRect().top + grabOffset,
  betaStartY - betaGroupBounds.y)
  expect(Math.abs(heldPointY - (alphaBounds.y + 2))).toBeLessThan(2)

  await touchEnd(betaSummary, { touchId, clientY: alphaBounds.y + 2 })

  await expect(page.locator(".structured_group_name")).toHaveText([
    "Default",
    "Beta",
    "Alpha"
  ])
  const persisted = JSON.parse(await page.getByTestId("sources").inputValue())
  expect(persisted.groups.map((group) => group.name)).toEqual(["Beta", "Alpha"])
  expect(persisted.sources.map((source) => source.url)).toEqual([
    fixture, `${fixture}?group=beta`, `${fixture}?group=alpha`
  ])
  expect(persisted.sources.map((source) => source.groupId ?? null)).toEqual([
    null, persisted.groups[0].id, persisted.groups[1].id
  ])
  await expect(groups.nth(0)).toHaveAttribute("open", "")
  await expect(groups.nth(1)).toHaveAttribute("open", "")
  await expect(groups.nth(2)).not.toHaveAttribute("open", "")
  const revealed = await groups.nth(1).evaluate((group) => {
    const bounds = group.getBoundingClientRect()
    const list = group.closest(".structured_settings").getBoundingClientRect()
    return bounds.top >= list.top && bounds.bottom <= list.bottom
  })
  expect(revealed).toBe(true)
  await page.locator("#settings_section_back").click()
  await expect(page.locator("#settings_panel"))
    .not.toHaveClass(/\bsettings_detail_open\b/)
})

test("story source groups expose drop targets below their touch origin", async ({
  page
}) => {
  const { groups } = await seedGroupedSources(page)
  const alpha = groups.nth(1)
  const beta = groups.nth(2)
  const alphaSummary = alpha.locator("summary")
  const alphaBounds = await alphaSummary.boundingBox()
  const betaBounds = await beta.locator("summary").boundingBox()
  expect(alphaBounds).not.toBeNull()
  expect(betaBounds).not.toBeNull()

  const touchId = 18
  await touchStart(alpha.locator(".structured_group_count"), {
    touchId,
    clientY: alphaBounds.y + alphaBounds.height / 2
  })
  await page.waitForTimeout(350)
  await expect(alpha).toHaveClass(/\bstructured_group_dragging\b/)

  const destinationY = betaBounds.y + betaBounds.height - 2
  expect(await touchMove(alphaSummary, {
    touchId,
    clientY: destinationY
  })).toBe(true)
  await expect(beta).toHaveClass(/\bstructured_group_drop_after\b/)
  await expect(beta).not.toHaveClass(/\bstructured_group_drop_before\b/)

  await touchEnd(alphaSummary, { touchId, clientY: destinationY })
  await expect(page.locator(".structured_group_name")).toHaveText([
    "Default",
    "Beta",
    "Alpha"
  ])
})

test("story sources can be dragged into empty groups", async ({ page }) => {
  await gotoMobileApp(page)
  await openSettingsSection(page, "sources")
  const fixture = new URL("/fixtures/feed.rss", page.url()).href
  await page.getByTestId("sources").fill([
    fixture,
    "*Empty"
  ].join("\n"))
  await saveSourcesAndWait(page)
  await page.getByTestId("sources-mode-toggle").click()

  const groups = page.locator(".structured_group")
  await expect(groups).toHaveCount(2)
  const source = groups.nth(0).getByTestId("source-row")
  const emptyGroup = groups.nth(1)
  const emptyList = emptyGroup.locator(".structured_rows")
  await expect(emptyList.locator(".structured_empty")).toHaveText("No sources")
  await emptyGroup.locator(".structured_group_name").click()
  await expect(emptyGroup).not.toHaveAttribute("open", "")
  await source.dragTo(emptyGroup.locator("summary"))

  await expect(groups.nth(0).getByTestId("source-row")).toHaveCount(0)
  await expect(groups.nth(1).getByTestId("source-row")).toHaveCount(1)
  await expect(groups.nth(1).getByTestId("source-row")).toContainText(fixture)
  await expect(groups.nth(1)).not.toHaveAttribute("open", "")
})
