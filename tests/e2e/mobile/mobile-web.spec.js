const { test, expect } = require("@playwright/test")

// Long-press anywhere on the row; ⋮ opens the same menu at the same anchor.
async function openStoryMenu(page, story) {
  await story.click({ delay: 700 })
  await expect(page.getByTestId("story-menu")).toBeVisible()
  // The app suppresses the synthetic release click from a long-press for up
  // to 250ms. Do not let the harness's next intentional tap get swallowed.
  await page.waitForTimeout(300)
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

async function openSettingsSection(page, section) {
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

async function setSwipeThreshold(page, stage, value) {
  const handle = page.getByTestId(`swipe-handle-right-${stage}`)
  const handleBox = await handle.boundingBox()
  const rulerBox = await page.getByTestId("swipe-ruler").boundingBox()
  if (!handleBox || !rulerBox) throw new Error("Swipe ruler is not visible")
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(
    rulerBox.x + value,
    handleBox.y + handleBox.height / 2,
    { steps: 2 }
  )
  await page.mouse.up()
  await expect(handle).toHaveAttribute("aria-valuenow", String(value))
}

async function openSwipeAdvanced(page) {
  const details = page.getByTestId("swipe-advanced")
  if (!(await details.evaluate((element) => element.open))) {
    await details.locator("summary").click()
  }
}

async function waitForSwipeSettings(page) {
  await expect(page.getByTestId("swipe-save-status"))
    .toHaveText("all changes saved")
}

test("structured settings sections do not autofocus search on mobile", async ({
  page
}) => {
  await page.goto("./")
  await page.getByTestId("settings-menu").click()
  const back = page.locator("#settings_section_back")

  for (const section of ["sources", "filters", "redirects"]) {
    await page.locator(`[data-settings-target="${section}"]`).click()
    await expect(back).toBeFocused()
    await expect(page.getByTestId(`${section}-list-search`)).not.toBeFocused()
    await back.click()
  }
})

test("list settings are the default and expose structured add actions", async ({ page }) => {
  await page.goto("./")
  await page.getByTestId("settings-menu").click()
  const sourcesSection = page.locator('[data-settings-target="sources"]')
  if (!(await sourcesSection.isVisible())) {
    await page.locator("#settings_section_back").click()
  }
  await sourcesSection.click()
  await expect(page.locator("#settings_panel .settings_title")).toHaveText(
    "Story sources"
  )
  await expect(
    page.locator(
      '[data-settings-section="sources"] .settings_panel_heading'
    )
  ).toBeHidden()
  const modeToggle = page.getByTestId("sources-mode-toggle")
  await expect(modeToggle).toHaveText("TXT")
  await expect(modeToggle).toHaveAttribute("aria-label", "Edit as text")
  await expect(modeToggle.locator("xpath=..")).toHaveClass(/\bbar\b/)
  await expect(page.getByTestId("sources-structured-list")).toBeVisible()
  await expect(page.getByTestId("sources")).toBeHidden()
  const addSource = page.getByTestId("add-source")
  await expect(addSource).toBeVisible()
  await addSource.click()
  await expect(addSource).toHaveClass(/\bmenu_open\b/)
  await expect(page.getByTestId("add-source-entry")).toBeVisible()
  await expect(page.getByTestId("add-group")).toBeVisible()
  const pickSourcePage = page.getByTestId("pick-source-page")
  await expect(pickSourcePage).toBeVisible()
  const pickerBounds = await pickSourcePage.evaluate((button) => {
    const bounds = button.getBoundingClientRect()
    return {
      left: bounds.left,
      right: bounds.right,
      viewportWidth: window.innerWidth
    }
  })
  expect(pickerBounds.left).toBeGreaterThanOrEqual(0)
  expect(pickerBounds.right).toBeLessThanOrEqual(pickerBounds.viewportWidth)
  await pickSourcePage.click()
  await expect(addSource).not.toHaveClass(/\bmenu_open\b/)
  await expect(page.getByTestId("text-input-dialog")).toBeVisible()
  await expect(page.getByTestId("text-input-value")).toHaveValue("https://")
  await page.getByTestId("text-input-cancel").click()
  await page.getByTestId("sources-mode-toggle").click()
  await page.getByTestId("sources").fill(
    Array.from({ length: 18 }, (_, index) =>
      `https://example.test/source-${index}`).join("\n")
  )
  await saveSourcesAndWait(page)
  await expect(page.getByTestId("sources-mode-toggle")).toHaveText("UI")
  await expect(page.getByTestId("sources-mode-toggle")).toHaveAttribute(
    "aria-label",
    "Edit as list"
  )
  await page.getByTestId("sources-mode-toggle").click()
  const sourceSearch = page.getByTestId("sources-list-search")
  await sourceSearch.fill("source-17")
  await expect(page.locator('[data-testid="source-row"]:visible'))
    .toHaveCount(1)
  await expect(page.locator(
    '[data-structured-section="sources"] .structured_search_status'
  )).toHaveText("1 result")
  // The row carries the error's short title; the full sentence lives behind
  // the issue button and in the error log.
  await expect(page.locator(
    '[data-testid="source-row"]:visible .structured_row_secondary_error'
  )).toContainText("No Handler")
  await sourceSearch.fill("")
  await expect(page.locator(
    '[data-testid="source-row"] mark'
  )).toHaveCount(0)
  const sourceList = page.getByTestId("sources-structured-list")
  const scrollMetrics = await sourceList.evaluate((element) => {
    const widthBeforeScroll = element.clientWidth
    element.scrollTop = element.scrollHeight
    return {
      top: element.scrollTop,
      height: element.clientHeight,
      scrollHeight: element.scrollHeight,
      widthBeforeScroll,
      widthWhileScrolling: element.clientWidth
    }
  })
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.height)
  expect(scrollMetrics.top).toBeGreaterThan(0)
  expect(scrollMetrics.widthWhileScrolling).toBe(scrollMetrics.widthBeforeScroll)
  await expect(sourceList).toHaveClass(/\bmobile_scrollbar_active\b/)
  await expect(page.locator(".mobile_scroll_indicator")).toBeVisible()
  await expect(sourceList).not.toHaveClass(
    /\bmobile_scrollbar_active\b/,
    { timeout: 1_500 }
  )
  await expect(page.locator(".mobile_scroll_indicator")).toHaveCSS("opacity", "0")

  await addSource.click()
  await page.getByTestId("add-source-entry").click()
  const sourceForm = page.getByTestId("structured-item-form")
  await expect(sourceForm).toBeVisible()
  await expect(sourceForm.getByTestId("structured-save")).toBeVisible()
  await expect(sourceForm.getByRole("button", { name: "Cancel" })).toBeVisible()
  await expect(addSource).toBeHidden()
  await page.locator("#settings_section_back").click()
  await expect(page.getByTestId("sources-structured-list")).toBeVisible()
  await expect(page.getByTestId("structured-item-form")).toBeHidden()
  await expect(page.locator("#settings_panel")).toHaveClass(
    /\bsettings_detail_open\b/
  )
  await page.getByTestId("sources-mode-toggle").click()
  await expect(page.getByTestId("sources")).toBeVisible()
})

test("filters edit inline and expose a row remove button", async ({ page }) => {
  await page.goto("./")
  await page.getByTestId("settings-menu").click()
  await page.locator('[data-settings-target="filters"]').click()

  const firstRow = page.getByTestId("filter-row").first()
  const filterMetrics = await firstRow.evaluate((button) => {
    const row = button.closest(".structured_row")
    const main = row?.querySelector(".structured_row_main")
    const secondary = row?.querySelector(".structured_row_secondary")
    const style = main && getComputedStyle(main)
    return {
      height: row?.getBoundingClientRect().height || 0,
      fontFamily: style?.fontFamily || "",
      hasSecondary: secondary !== null
    }
  })
  expect(filterMetrics.height).toBe(48)
  expect(filterMetrics.fontFamily.toLowerCase()).toContain("courier new")
  expect(filterMetrics.hasSecondary).toBe(false)
  const original = await firstRow.textContent()
  await firstRow.click()
  const input = page.getByTestId("filter-inline-input")
  await expect(input).toBeFocused()
  await input.fill(`${original}-edited`)
  await input.press("Enter")
  await expect(page.getByTestId("filter-row").first()).toHaveText(
    `${original}-edited`
  )

  page.once("dialog", (dialog) => dialog.accept())
  await page.getByTestId("remove-filter").first().click()
  await expect(page.getByTestId("filter-row").first()).not.toHaveText(
    `${original}-edited`
  )

  const rows = page.locator(
    '[data-structured-section="filters"] .structured_row'
  )
  const firstValue = await page.getByTestId("filter-row").nth(0).textContent()
  const secondValue = await page.getByTestId("filter-row").nth(1).textContent()
  await dragBelowMidpoint(rows.nth(0), rows.nth(1))
  await expect(page.getByTestId("filter-row").nth(0)).toHaveText(secondValue)
  await expect(page.getByTestId("filter-row").nth(1)).toHaveText(firstValue)

  await expect(page.locator(".structured_move_actions")).toHaveCount(0)

  const filterSearch = page.getByTestId("filters-list-search")
  await filterSearch.fill(secondValue)
  await expect(page.locator('[data-testid="filter-row"]:visible'))
    .toHaveCount(1)
  await expect(page.locator(
    '[data-structured-section="filters"] .structured_search_status'
  )).toHaveText("1 result")
  await filterSearch.fill("")

  const list = page.getByTestId("filters-structured-list")
  await list.evaluate((element) => {
    element.scrollTop = 0
    const bounds = element.getBoundingClientRect()
    element.dispatchEvent(new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.bottom - 2,
      dataTransfer: new DataTransfer()
    }))
  })
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0)

  const bottomScrollTop = await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    const start = element.scrollTop
    const bounds = element.getBoundingClientRect()
    element.dispatchEvent(new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + 2,
      dataTransfer: new DataTransfer()
    }))
    return start
  })
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBeLessThan(bottomScrollTop)
  await list.evaluate((element) => {
    element.dispatchEvent(new DragEvent("drop", { bubbles: true }))
  })
})

test("redirect list search matches expressions and replacement targets", async ({
  page
}) => {
  await page.goto("./")
  await openSettingsSection(page, "redirects")
  await page.getByTestId("redirects").fill(
    "first.example => destination.example/one\n" +
    "second.example => destination.example/two"
  )
  await page.getByTestId("save-redirects").click()
  await page.getByTestId("redirects-mode-toggle").click()

  const search = page.getByTestId("redirects-list-search")
  await search.fill("destination.example/two")
  const visibleRows = page.locator('[data-testid="redirect-row"]:visible')
  await expect(visibleRows).toHaveCount(1)
  await expect(visibleRows).toContainText("second.example")
  await expect(page.locator(
    '[data-structured-section="redirects"] .structured_search_status'
  )).toHaveText("1 result")

  await search.fill("")
  const redirectRows = page.locator('[data-testid="redirect-row"]:visible')
  await expect(redirectRows).toHaveCount(2)
  // Drop into the lower half: the midpoint decides before-vs-after, and a
  // drop exactly on it means "insert before", which for the row above is a
  // no-op rather than a move.
  await dragBelowMidpoint(redirectRows.nth(0), redirectRows.nth(1))
  await expect(redirectRows.nth(0)).toContainText("second.example")
  await expect(redirectRows.nth(1)).toContainText("first.example")
})

test("story source groups collapse while dragging and restore afterward", async ({
  page
}) => {
  await page.goto("./")
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
      backCenterY: back && back.top + back.height / 2,
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
  const defaultSource = groups.nth(0).locator(".structured_row")
  const alphaSource = groups.nth(1).locator(".structured_row")
  await defaultSource.evaluate((source, target) => {
    const transfer = new DataTransfer()
    source.dispatchEvent(new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer
    }))
    const bounds = target.getBoundingClientRect()
    // Android WebView can send movement to the drag source without firing
    // dragover on the row underneath it.
    source.dispatchEvent(new DragEvent("drag", {
      bubbles: true,
      cancelable: true,
      clientY: bounds.top + 1,
      dataTransfer: transfer
    }))
  }, await alphaSource.elementHandle())
  await expect(alphaSource).toHaveClass(/\bstructured_source_drop_before\b/)
  await defaultSource.evaluate((source, target) => {
    const transfer = new DataTransfer()
    source.dispatchEvent(new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer
    }))
    const bounds = target.getBoundingClientRect()
    target.dispatchEvent(new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientY: bounds.bottom - 1,
      dataTransfer: transfer
    }))
  }, await alphaSource.elementHandle())
  await expect(alphaSource).toHaveClass(/\bstructured_source_drop_after\b/)
  await defaultSource.evaluate((source) => {
    source.dispatchEvent(new DragEvent("dragend", {
      bubbles: true,
      cancelable: true
    }))
  })
  await expect(alphaSource).not.toHaveClass(/\bstructured_source_drop_before\b/)
  await expect(alphaSource).not.toHaveClass(/\bstructured_source_drop_after\b/)
  await groups.nth(1).locator(".structured_group_name").click()
  await expect(groups.nth(1)).not.toHaveAttribute("open", "")
  await expect(groups.nth(0)).toHaveAttribute("open", "")
  await expect(groups.nth(2)).toHaveAttribute("open", "")

  const betaName = groups.nth(2).locator(".structured_group_name")
  await betaName.evaluate((name) => {
    const transfer = new DataTransfer()
    name.dispatchEvent(new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer
    }))
  })
  await expect(page.getByTestId("sources-structured-list"))
    .toHaveClass(/\bstructured_group_drag_active\b/)
  await expect(groups.locator(".structured_rows").first()).toBeHidden()
  await expect(groups.nth(0)).toHaveAttribute("open", "")
  await expect(groups.nth(1)).not.toHaveAttribute("open", "")
  await expect(groups.nth(2)).toHaveAttribute("open", "")

  await betaName.evaluate((name) => {
    name.dispatchEvent(new DragEvent("dragend", {
      bubbles: true,
      cancelable: true
    }))
  })
  await expect(groups.nth(0)).toHaveAttribute("open", "")
  await expect(groups.nth(1)).not.toHaveAttribute("open", "")
  await expect(groups.nth(2)).toHaveAttribute("open", "")

  const alphaSummaryForScroll = groups.nth(1).locator("summary")
  const alphaScrollBounds = await alphaSummaryForScroll.boundingBox()
  expect(alphaScrollBounds).not.toBeNull()
  const scrollTouchId = 16
  const scrollMovePrevented = await alphaSummaryForScroll.evaluate(
    async (summary, { pointerId, clientY }) => {
      const start = new Touch({
        identifier: pointerId,
        target: summary,
        clientY
      })
      summary.dispatchEvent(new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [start],
        changedTouches: [start]
      }))
      const moved = new Touch({
        identifier: pointerId,
        target: summary,
        clientY: clientY + 10
      })
      const move = new TouchEvent("touchmove", {
        bubbles: true,
        cancelable: true,
        touches: [moved],
        changedTouches: [moved]
      })
      summary.dispatchEvent(move)
      return move.defaultPrevented
    }, {
      pointerId: scrollTouchId,
      clientY: alphaScrollBounds.y + alphaScrollBounds.height / 2
    })
  expect(scrollMovePrevented).toBe(false)
  await expect(page.getByTestId("sources-structured-list"))
    .not.toHaveClass(/\bstructured_group_drag_active\b/)

  const betaBounds = await betaName.boundingBox()
  expect(betaBounds).not.toBeNull()
  const betaGroupBounds = await groups.nth(2).boundingBox()
  expect(betaGroupBounds).not.toBeNull()
  const betaSummary = groups.nth(2).locator("summary")
  const betaCount = groups.nth(2).locator(".structured_group_count")
  const pointerId = 17
  const betaStartY = betaBounds.y + betaBounds.height / 2
  // The whole title bar is the touch handle, not only the group name.
  await betaCount.evaluate((count, { pointerId, clientY }) => {
    const touch = new Touch({
      identifier: pointerId,
      target: count,
      clientY
    })
    count.dispatchEvent(new TouchEvent("touchstart", {
      bubbles: true,
      cancelable: true,
      touches: [touch],
      changedTouches: [touch]
    }))
  }, { pointerId, clientY: betaStartY })
  await page.waitForTimeout(350)
  await expect(page.getByTestId("sources-structured-list"))
    .toHaveClass(/\bstructured_group_drag_active\b/)
  await expect(groups.nth(2)).toHaveClass(/\bstructured_group_dragging\b/)
  await expect(groups.nth(1)).toHaveClass(/\bstructured_group_drop_after\b/)
  const defaultBounds = await groups.nth(0).locator("summary").boundingBox()
  expect(defaultBounds).not.toBeNull()
  const defaultMovePrevented = await betaSummary.evaluate(
    (summary, { pointerId, clientY }) => {
      const touch = new Touch({
        identifier: pointerId,
        target: summary,
        clientY
      })
      const event = new TouchEvent("touchmove", {
        bubbles: true,
        cancelable: true,
        touches: [touch],
        changedTouches: [touch]
      })
      summary.dispatchEvent(event)
      return event.defaultPrevented
    }, { pointerId, clientY: defaultBounds.y + 1 })
  expect(defaultMovePrevented).toBe(true)
  await expect(groups.nth(0)).toHaveClass(/\bstructured_group_drop_after\b/)
  await expect(groups.nth(0)).not.toHaveClass(/\bstructured_group_drop_before\b/)
  const alphaBounds = await groups.nth(1).locator("summary").boundingBox()
  expect(alphaBounds).not.toBeNull()
  const alphaMovePrevented = await betaSummary.evaluate(
    (summary, { pointerId, clientY }) => {
      const touch = new Touch({
        identifier: pointerId,
        target: summary,
        clientY
      })
      const event = new TouchEvent("touchmove", {
        bubbles: true,
        cancelable: true,
        touches: [touch],
        changedTouches: [touch]
      })
      summary.dispatchEvent(event)
      return event.defaultPrevented
    }, { pointerId, clientY: alphaBounds.y + 2 })
  expect(alphaMovePrevented).toBe(true)
  await expect(groups.nth(1)).toHaveClass(/\bstructured_group_drop_before\b/)
  const draggedTransform = await groups.nth(2).evaluate((group) =>
    getComputedStyle(group).transform)
  expect(draggedTransform).not.toBe("none")
  const heldPointY = await groups.nth(2).evaluate((group, grabOffset) =>
    group.getBoundingClientRect().top + grabOffset,
  betaStartY - betaGroupBounds.y)
  expect(Math.abs(heldPointY - (alphaBounds.y + 2))).toBeLessThan(2)
  await betaSummary.evaluate((summary, { pointerId, clientY }) => {
    const touch = new Touch({
      identifier: pointerId,
      target: summary,
      clientY
    })
    summary.dispatchEvent(new TouchEvent("touchend", {
      bubbles: true,
      cancelable: true,
      touches: [],
      changedTouches: [touch]
    }))
  }, { pointerId, clientY: alphaBounds.y + 2 })

  await expect(page.locator(".structured_group_name")).toHaveText([
    "Default",
    "Beta",
    "Alpha"
  ])
  await expect(page.getByTestId("sources")).toHaveValue([
    fixture,
    "*Beta",
    `${fixture}?group=beta`,
    "*Alpha",
    `${fixture}?group=alpha`
  ].join("\n"))
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

test("story sources can be dragged into empty groups", async ({ page }) => {
  await page.goto("./")
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

async function testServerUrl(page, path) {
  return new URL(path, page.url()).href
}

async function saveSourcesAndWait(page) {
  const save = page.getByTestId("save-sources")
  await save.click()
  await expect(save).toBeEnabled()
}

async function triggerMobileBack(page) {
  return page.evaluate(() => window.__onceE2E__.handleBack())
}

test("mobile layout is present before application JavaScript starts", async ({ page }) => {
  await page.route("**/mobile.js", (route) => route.abort())
  await page.goto("./", { waitUntil: "domcontentloaded" })

  await expect(page.locator('link[rel="stylesheet"][href="mobile.css"]'))
    .toHaveCount(1)
  await expect(page.locator("body")).toHaveAttribute("data-platform", "mobile")
  await expect(page.locator("#right_panel")).toBeHidden()
  await expect(page.locator("#menu")).toHaveCSS("position", "fixed")
  await expect(page.locator("#menu")).toHaveCSS("bottom", "0px")
  await expect.poll(() => page.locator("#reload_stories_btn").evaluate(
    (button) => getComputedStyle(button, "::before").webkitMaskImage
  )).toContain("/app/imgs/reload.svg")
})

test("mobile shell is responsive and hides unavailable capabilities", async ({ page }) => {
  await page.goto("./")
  await expect(page.locator("body")).toHaveAttribute("data-platform", "mobile")
  await expect(page.locator("body")).toHaveAttribute("data-once-ready", "true")
  await expect(page.getByTestId("app-version")).toContainText("dev")
  await expect(page.getByTestId("pick-source")).toBeHidden()
  await expect(page.getByTestId("settings-menu")).toBeVisible()
  await expect(page.getByTestId("stories-menu")).toBeVisible()
  expect(await page.locator("#left_panel").evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true)
  const trailingStorySpace = await page.locator("#stories").evaluate((stories) => {
    const finalStory = document.createElement("article")
    finalStory.style.cssText = "display:block;flex:0 0 1200px;height:1200px"
    stories.replaceChildren(finalStory)
    stories.scrollTop = stories.scrollHeight
    const menu = document.querySelector("#menu")
    return menu.getBoundingClientRect().top -
      finalStory.getBoundingClientRect().bottom
  })
  expect(trailingStorySpace).toBeGreaterThanOrEqual(0)
  expect(trailingStorySpace).toBeLessThanOrEqual(1)
})

test("settings menu always resets to a clean section index", async ({ page }) => {
  await page.goto("./")
  await page.getByTestId("settings-menu").click()
  await page.locator("#settings_search").fill("two-stage")
  await page.locator('[data-settings-target="swipe"]').click()
  await page.getByTestId("stories-menu").click()

  await page.getByTestId("settings-menu").click()

  await expect(page.locator("#settings_panel")).not.toHaveClass(
    /\bsettings_detail_open\b/
  )
  await expect(page.locator(".settings_section.active")).toHaveCount(0)
  await expect(page.locator("#settings_search")).toHaveValue("")
  await expect(page.locator(".settings_section_row").filter({
    visible: true
  })).toHaveCount(9)
})

test("mobile back unwinds settings before restoring its previous panel", async ({ page }) => {
  await page.goto("./")
  const leftPanel = page.locator("#left_panel")

  await openSettingsSection(page, "swipe")
  await expect(page.locator("#settings_panel")).toHaveClass(
    /\bsettings_detail_open\b/
  )

  expect(await triggerMobileBack(page)).toBe(true)
  await expect(page.locator("#settings_panel")).not.toHaveClass(
    /\bsettings_detail_open\b/
  )
  await expect(leftPanel).toHaveAttribute("active_panel", "settings")

  expect(await triggerMobileBack(page)).toBe(true)
  await expect(leftPanel).toHaveAttribute("active_panel", "stories")

  await page.getByTestId("reading-menu").click()
  await page.getByTestId("settings-menu").click()
  expect(await triggerMobileBack(page)).toBe(true)
  await expect(leftPanel).toHaveAttribute("active_panel", "reading")
})

test("settings chevron back returns to the previous panel", async ({ page }) => {
  await page.goto("./")
  const leftPanel = page.locator("#left_panel")
  const settingsBack = page.locator("#settings_section_back")
  const desktopCollapse = page.locator("#settings_panel .collapsebutton")

  await page.getByTestId("settings-menu").click()
  await expect(settingsBack).toBeVisible()
  await expect(settingsBack).toHaveAttribute("aria-label", "Back")
  await expect(desktopCollapse).toBeHidden()
  await settingsBack.click()
  await expect(leftPanel).toHaveAttribute("active_panel", "stories")

  await page.getByTestId("reading-menu").click()
  await page.getByTestId("settings-menu").click()
  await settingsBack.press("Enter")
  await expect(leftPanel).toHaveAttribute("active_panel", "reading")
})

test("swipe settings autosave, undo, and reset without submit controls", async ({
  page
}) => {
  await page.goto("./")
  await openSettingsSection(page, "swipe")

  await expect(page.getByTestId("save-swipe")).toHaveCount(0)
  await expect(page.getByTestId("undo-swipe")).toBeDisabled()
  await page.getByTestId("swipe-right-1").selectOption("toggle-bookmark")
  await expect(page.getByTestId("swipe-save-status")).toHaveText("saving…")
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

test("mobile back dismisses transient story interactions before exiting", async ({ page }) => {
  const story = await seedFixtureStories(page)
  const searchfield = page.locator("#searchfield")

  await story.locator(".hostname").click()
  await expect(searchfield).toHaveValue(/^domain:/)
  await expect(page.locator("#stories")).toBeHidden()

  expect(await triggerMobileBack(page)).toBe(true)
  await expect(searchfield).toHaveValue("")
  await expect(page.locator("#stories")).toBeVisible()
  await expect(story).toBeVisible()

  await story.getByTestId("story-menu-button").click()
  await expect(page.getByTestId("story-menu")).toBeVisible()
  expect(await triggerMobileBack(page)).toBe(true)
  await expect(page.getByTestId("story-menu")).toBeHidden()

  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-filter").click()
  await expect(page.getByTestId("text-input-dialog")).toBeVisible()
  expect(await triggerMobileBack(page)).toBe(true)
  await expect(page.getByTestId("text-input-dialog")).toBeHidden()

  await searchfield.focus()
  expect(await triggerMobileBack(page)).toBe(true)
  await expect(searchfield).not.toBeFocused()

  expect(await triggerMobileBack(page)).toBe(false)
})

test("mobile back returns an empty Reading tab to Stories", async ({ page }) => {
  await page.goto("./")
  await page.getByTestId("reading-menu").click()
  await expect(page.locator("#left_panel")).toHaveAttribute(
    "active_panel",
    "reading"
  )

  const address = page.locator("#reading_url")
  await expect(address).toHaveAttribute("placeholder", "Enter a URL")
  await expect(page.getByTestId("reading-empty")).toHaveText(
    "Open a story or enter a URL above to start reading."
  )
  await expect(page.getByTestId("reading-empty")).toBeVisible()
  await address.focus()
  expect(await triggerMobileBack(page)).toBe(true)
  await expect(address).not.toBeFocused()
  await expect(page.locator("#left_panel")).toHaveAttribute(
    "active_panel",
    "reading"
  )

  expect(await triggerMobileBack(page)).toBe(true)
  await expect(page.locator("#left_panel")).toHaveAttribute(
    "active_panel",
    "stories"
  )
})

test("mobile text settings use the detail panel as an editor workspace", async ({ page }) => {
  await page.goto("./")
  await openSettingsSection(page, "filters")

  const layout = await page.locator(
    '.settings_section[data-settings-section="filters"]'
  ).evaluate((section) => {
    const block = section.querySelector(".settings_editor_block")
    const editor = section.querySelector(".input_container")
    const actions = section.querySelector(".settings_actions")
    const sectionBounds = section.getBoundingClientRect()
    const blockBounds = block.getBoundingClientRect()
    const editorBounds = editor.getBoundingClientRect()
    const actionBounds = actions.getBoundingClientRect()
    const blockStyle = getComputedStyle(block)
    return {
      sectionHeight: sectionBounds.height,
      blockWidth: blockBounds.width,
      editorWidth: editorBounds.width,
      editorHeight: editorBounds.height,
      actionsBottom: actionBounds.bottom,
      sectionBottom: sectionBounds.bottom,
      blockBorder: blockStyle.borderTopWidth,
      blockMargin: blockStyle.marginTop
    }
  })

  expect(layout.blockBorder).toBe("0px")
  expect(layout.blockMargin).toBe("0px")
  expect(layout.editorWidth).toBeGreaterThan(layout.blockWidth - 32)
  expect(layout.editorHeight).toBeGreaterThan(layout.sectionHeight * 0.65)
  expect(layout.actionsBottom).toBeLessThanOrEqual(layout.sectionBottom)
})

test("mobile refresh controls stay separated and theme-aware", async ({ page }) => {
  await page.goto("./")
  await expect(page.locator("body")).toHaveAttribute("data-once-ready", "true")

  const refreshControls = await page.evaluate(() => {
    const reload = document.querySelector("#reload_stories_btn")
    const reading = document.querySelector("#reading_navigate")
    const reloadStyle = getComputedStyle(reload)
    const readingStyle = getComputedStyle(reading)
    reload.classList.add("disabled")
    reading.classList.add("loading")
    reading.disabled = true
    return {
      reload: {
        width: reloadStyle.width,
        height: reloadStyle.height,
        border: reloadStyle.border,
        radius: reloadStyle.borderRadius,
        background: reloadStyle.backgroundColor
      },
      reading: {
        width: readingStyle.width,
        height: readingStyle.height,
        border: readingStyle.border,
        radius: readingStyle.borderRadius,
        background: readingStyle.backgroundColor
      },
      reloadOpacity: getComputedStyle(reload).opacity,
      readingOpacity: getComputedStyle(reading).opacity,
      reloadAnimation: getComputedStyle(reload, "::before").animationName,
      readingAnimation: getComputedStyle(reading, "::before").animationName,
      readingMask: getComputedStyle(reading, "::before").webkitMaskImage
    }
  })
  expect(refreshControls.reading).toEqual(refreshControls.reload)
  expect(refreshControls.reloadOpacity).toBe("1")
  expect(refreshControls.readingOpacity).toBe("1")
  expect(refreshControls.reloadAnimation).toBe("rotating")
  expect(refreshControls.readingAnimation).toBe("rotating")
  expect(refreshControls.readingMask).toContain("reload.svg")

  const listTopBeforePull = await page.locator("#stories").evaluate(
    (stories) => stories.getBoundingClientRect().top
  )
  await page.locator("#stories").evaluate((stories) => {
    const touch = new Touch({
      identifier: 1,
      target: stories,
      clientX: 200,
      clientY: 100
    })
    stories.dispatchEvent(new TouchEvent("touchstart", {
      bubbles: true,
      cancelable: true,
      touches: [touch]
    }))
    const moved = new Touch({
      identifier: 1,
      target: stories,
      clientX: 200,
      clientY: 150
    })
    stories.dispatchEvent(new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [moved]
    }))
  })
  const pullGeometry = await page.locator("#stories").evaluate((stories) => {
    const indicator = stories.querySelector(".ptr-indicator")
    const surface = indicator.querySelector(".ptr-surface")
    const listBounds = stories.getBoundingClientRect()
    const indicatorBounds = indicator.getBoundingClientRect()
    const surfaceBounds = surface.getBoundingClientRect()
    return {
      listTop: listBounds.top,
      indicatorTop: indicatorBounds.top,
      indicatorBottom: indicatorBounds.bottom,
      surfaceTop: surfaceBounds.top,
      surfaceBottom: surfaceBounds.bottom,
      indicatorPosition: getComputedStyle(indicator).position
    }
  })
  expect(pullGeometry.listTop).toBe(listTopBeforePull)
  expect(pullGeometry.indicatorPosition).toBe("absolute")
  expect(pullGeometry.indicatorTop).toBe(listTopBeforePull)
  expect(pullGeometry.surfaceTop).toBeLessThan(pullGeometry.indicatorBottom)
  expect(pullGeometry.surfaceBottom).toBeGreaterThan(listTopBeforePull)
  expect(
    pullGeometry.indicatorBottom - pullGeometry.surfaceBottom
  ).toBeGreaterThanOrEqual(10)

  for (const theme of ["light", "dark"]) {
    await page.locator("body").evaluate((body, value) => {
      body.dataset.theme = value
    }, theme)
    const colors = await page.locator(".ptr-surface").evaluate((surface) => {
      const body = document.body
      const icon = surface.querySelector(".ptr-icon")
      const reload = document.querySelector("#reload_stories_btn")
      return {
        surface: getComputedStyle(surface).backgroundColor,
        body: getComputedStyle(body).backgroundColor,
        icon: getComputedStyle(icon).backgroundColor,
        reload: getComputedStyle(reload).color
      }
    })
    expect(colors.surface).not.toBe(colors.body)
    expect(colors.icon).toBe(colors.reload)
  }
})

test("mobile settings persist without contacting external sources", async ({ page }) => {
  await page.goto("./")
  await openSettingsSection(page, "sources")
  await page.getByTestId("sources").fill(await testServerUrl(page, "/fixtures/feed.rss"))
  await saveSourcesAndWait(page)
  await page.reload()
  await openSettingsSection(page, "sources")
  await expect(page.getByTestId("sources")).toHaveValue(/\/fixtures\/feed\.rss/)
})

test("stories persist offline and open in the in-app reader", async ({ page }) => {
  await page.goto("./")
  await openSettingsSection(page, "sources")
  await page.getByTestId("sources").fill(await testServerUrl(page, "/fixtures/feed.rss"))
  await saveSourcesAndWait(page)
  await page.reload()
  await openSettingsSection(page, "sources")
  await expect(page.getByTestId("sources")).toHaveValue(/\/fixtures\/feed\.rss/)
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()

  const story = page.getByTestId("story").filter({ hasText: "Fixture article" })
  await expect(story).toBeVisible()
  // story actions live in the anchored ⋮ menu on mobile
  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-open-reader").click()
  await expect(page.locator("#reading_content")).toHaveAttribute("data-mode", "reader")
  await expect(page.getByTestId("reading-empty")).toBeHidden()
  const reader = page.locator(".once-reader-host-frame").contentFrame()
  await expect(reader.getByRole("heading", { name: "Fixture article" })).toBeVisible()
  await expect(reader.locator("body")).toHaveCSS("max-width", "700px")
  await expect(reader.locator(".toolbar")).toBeHidden()
  await expect(reader.locator(".reader-original")).toBeHidden()
  await expect(page.getByTestId("reader-tts-bar")).toBeVisible()
  await expect(reader.locator("html")).toHaveAttribute("data-once-tts-installed", "true")
  await expect(reader.locator("article .tts-segment")).not.toHaveCount(0)
  await page.getByTestId("stories-menu").click()
  // Switching tabs hides Reading but preserves it as a persistent workspace.
  await expect(page.locator(".once-reader-host-frame")).toBeAttached()
  await page.getByTestId("reading-menu").click()
  await expect(reader.getByRole("heading", { name: "Fixture article" })).toBeVisible()
  await expect(page.locator("#reading_content")).toHaveAttribute("data-mode", "reader")
  await page.getByTestId("stories-menu").click()

  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-toggle-read").click()
  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-toggle-read").click()
  await expect(story).toHaveClass(/skipped/)
  await page.waitForTimeout(500)
  await page.reload()
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()
  await expect(page.getByTestId("story").filter({ hasText: "Fixture article" })).toHaveClass(/skipped/)
})

test("the ⋮ button opens the story menu anchored above the tab bar", async ({ page }) => {
  await page.goto("./")
  await openSettingsSection(page, "sources")
  await page.getByTestId("sources").fill(await testServerUrl(page, "/fixtures/feed.rss"))
  await saveSourcesAndWait(page)
  await page.reload()
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()

  const story = page.getByTestId("story").filter({ hasText: "Fixture article" })
  await expect(story).toBeVisible()

  // A tap on ⋮ opens the menu directly — no long-press, no swipe armed.
  await story.getByTestId("story-menu-button").click()
  const menu = page.getByTestId("story-menu")
  await expect(menu).toBeVisible()
  await expect(page.getByTestId("story-menu-open-comments")).toBeVisible()
  await expect(page.getByTestId("story-menu-open-browser")).toBeVisible()
  await expect(page.getByTestId("story-menu-open-reader")).toBeVisible()
  // Tab-target actions belong to desktop only.
  await expect(page.getByTestId("story-menu-open-new-tab")).toHaveCount(0)

  const geometry = await menu.evaluate((panel) => {
    const rect = panel.getBoundingClientRect()
    const rowEl = document.querySelector("story-item")
    const row = rowEl.getBoundingClientRect()
    const tabs = document.querySelector("#menu").getBoundingClientRect()
    const button = document
      .querySelector("story-item .menu_btn")
      .getBoundingClientRect()
    const data = rowEl.querySelector(".data").getBoundingClientRect()
    const title = rowEl.querySelector(".title").getBoundingClientRect()
    return {
      // right-aligned to the row it belongs to
      rightGap: Math.abs(rect.right - row.right),
      // never reaches behind the fixed tab bar
      clearsTabBar: rect.bottom <= tabs.top,
      buttonHeight: Math.round(button.height),
      buttonWidth: Math.round(button.width),
      buttonRightGap: Math.round(row.right - button.right),
      buttonBottomGap: Math.round(row.bottom - button.bottom),
      // The button no longer consumes a full-height column beside the title.
      titleRightGap: Math.round(data.right - title.right)
    }
  })
  expect(geometry.rightGap).toBeLessThanOrEqual(8)
  expect(geometry.clearsTabBar).toBe(true)
  // Compact and inset from the right, while the title keeps the row's full
  // text width.
  expect(geometry.buttonHeight).toBe(28)
  expect(geometry.buttonWidth).toBe(28)
  expect(geometry.buttonRightGap).toBe(12)
  expect(geometry.buttonBottomGap).toBe(16)
  expect(geometry.titleRightGap).toBeLessThanOrEqual(1)

  // Tapping the backdrop dismisses without running an action.
  await page.getByTestId("story-menu-backdrop").click({ position: { x: 5, y: 5 } })
  await expect(menu).toBeHidden()
  await expect(story).not.toHaveClass(/read/)

  // A row low on the screen flips the menu above itself rather than letting it
  // slide behind the tab bar.
  await page.locator("#stories").evaluate((stories) => {
    stories.style.paddingTop = "600px"
  })
  await story.getByTestId("story-menu-button").click()
  await expect(menu).toBeVisible()
  const flipped = await menu.evaluate((panel) => {
    const rect = panel.getBoundingClientRect()
    const row = document.querySelector("story-item").getBoundingClientRect()
    const tabs = document.querySelector("#menu").getBoundingClientRect()
    return {
      above: rect.bottom <= row.top,
      gap: Math.round(row.top - rect.bottom),
      clearsTabBar: rect.bottom <= tabs.top
    }
  })
  expect(flipped.above).toBe(true)
  expect(flipped.gap).toBe(4)
  expect(flipped.clearsTabBar).toBe(true)
})

test("filter actions open a visible editor from the menu and a swipe", async ({ page }) => {
  const story = await seedFixtureStories(page)

  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-filter").click()
  const dialog = page.getByTestId("text-input-dialog")
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId("text-input-value")).toHaveValue("127.0.0.1")
  await page.getByTestId("text-input-cancel").click()
  await expect(dialog).toBeHidden()

  await openSettingsSection(page, "swipe")
  await page.getByTestId("swipe-left-1").selectOption("filter")
  await waitForSwipeSettings(page)
  await page.waitForTimeout(300)
  await page.getByTestId("stories-menu").click()

  const swipe = await dragStory(story, -110, { release: false })
  expect(swipe.action).toBe("filter")
  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
  await expect(dialog).toBeVisible()
  await page.getByTestId("text-input-value").fill("fixture-filter.example")
  await page.getByTestId("text-input-accept").click()
  await expect(dialog).toBeHidden()

  await openSettingsSection(page, "filters")
  await expect(page.locator("#filter_area")).toHaveValue(/fixture-filter\.example/)
})

test("a long-press that becomes a drag shows progress and opens nothing", async ({ page }) => {
  await page.goto("./")
  await openSettingsSection(page, "sources")
  await page.getByTestId("sources").fill(await testServerUrl(page, "/fixtures/feed.rss"))
  await saveSourcesAndWait(page)
  await page.reload()
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()

  const story = page.getByTestId("story").filter({ hasText: "Fixture article" })
  await expect(story).toBeVisible()

  const result = await story.evaluate(async (row) => {
    const rect = row.getBoundingClientRect()
    const press = (type, x, target) => {
      const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        isPrimary: true,
        pointerId: 7,
        pointerType: "touch",
        button: 0,
        clientX: x,
        clientY: rect.top + 20
      })
      target.dispatchEvent(event)
    }
    press("pointerdown", rect.left + 40, row)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const building = getComputedStyle(row, "::after")
    const started = {
      marked: row.classList.contains("press_building"),
      animation: building.animationName,
      duration: building.animationDuration,
      delay: building.animationDelay,
      height: building.height
    }
    // past MOVE_TOLERANCE_PX — the swipe handler owns the gesture now
    press("pointermove", rect.left + 140, document)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const cancelled = row.classList.contains("press_building")
    press("pointerup", rect.left + 140, document)
    // outlast the 500ms long-press threshold
    await new Promise((resolve) => setTimeout(resolve, 600))
    return { started, cancelled }
  })

  expect(result.started.marked).toBe(true)
  expect(result.started.animation).toBe("once-press-progress")
  expect(result.started.duration).toBe("0.4s")
  expect(result.started.delay).toBe("0.1s")
  expect(result.started.height).toBe("2px")
  expect(result.cancelled).toBe(false)
  await expect(page.getByTestId("story-menu")).toBeHidden()
})

async function seedFixtureStories(page) {
  await page.goto("./")
  await openSettingsSection(page, "sources")
  await page.getByTestId("sources").fill(await testServerUrl(page, "/fixtures/feed.rss"))
  await saveSourcesAndWait(page)
  await page.reload()
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()
  const story = page.getByTestId("story").filter({ hasText: "Fixture article" })
  await expect(story).toBeVisible()
  return story
}

// Drives the touch path (not the mouse path) so the axis lock is exercised too.
// `moves` are the fractions of `distance` the finger is sampled at — a real
// flick reports far fewer, coarser moves than a slow drag.
async function dragStory(
  story,
  distance,
  { release = true, moves = [0.2, 0.5, 0.8, 1] } = {}
) {
  return story.evaluate(
    async (row, options) => {
      const rect = row.getBoundingClientRect()
      const y = rect.top + rect.height / 2
      const startX = rect.left + 40
      const touch = (x) =>
        new Touch({ identifier: 3, target: row, clientX: x, clientY: y })
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
      for (const fraction of options.moves) {
        fire("touchmove", startX + options.distance * fraction)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      // Sample only after the transform has stopped changing. Waiting on the
      // rendered state avoids assuming the 90ms snap transition will finish
      // within a fixed wall-clock delay on a loaded CI worker.
      await new Promise((resolve) => {
        const deadline = performance.now() + 750
        let previous = getComputedStyle(row).transform
        let stableFrames = 0
        const sample = () => {
          const current = getComputedStyle(row).transform
          stableFrames = current === previous ? stableFrames + 1 : 0
          previous = current
          if (stableFrames >= 3 || performance.now() >= deadline) {
            resolve()
            return
          }
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
      const revealedLabel = document.querySelector(
        options.distance > 0
          ? ".bb_slide .swipe_left"
          : ".bb_slide .swipe_right"
      )
      const state = {
        transform: getComputedStyle(row).transform,
        label:
          document.querySelector(".bb_slide .swipe_left .swipe_action_primary")
            ?.innerText || "",
        labelRight:
          document.querySelector(".bb_slide .swipe_right .swipe_action_primary")
            ?.innerText || "",
        secondaryLabel:
          revealedLabel?.querySelector(".swipe_action_secondary")?.innerText || "",
        labelWeight: revealedLabel
          ? getComputedStyle(
            revealedLabel.querySelector(".swipe_action_primary") || revealedLabel
          ).fontWeight
          : "",
        action:
          document.querySelector('.bb_slide [data-stage="1"], .bb_slide [data-stage="2"]')
            ?.dataset.action || "none"
      }
      if (options.release) {
        document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
      }
      return state
    },
    { distance, release, moves }
  )
}

async function sampleSwipePhases(story, distance, waits) {
  return story.evaluate(
    async (row, options) => {
      const rect = row.getBoundingClientRect()
      const y = rect.top + rect.height / 2
      const startX = options.distance > 0 ? rect.left + 40 : rect.right - 40
      const touch = (x) =>
        new Touch({ identifier: 11, target: row, clientX: x, clientY: y })
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
      fire("touchmove", startX + options.distance)
      const snapshots = []
      for (const wait of options.waits) {
        await new Promise((resolve) => setTimeout(resolve, wait))
        const side = options.distance > 0 ? ".swipe_left" : ".swipe_right"
        const revealed = document.querySelector(`.bb_slide ${side}`)
        snapshots.push({
          action: revealed?.dataset.action,
          lock: revealed?.dataset.lock,
          phase: revealed?.dataset.lockPhase,
          primary:
            revealed?.querySelector(".swipe_action_primary")?.textContent,
          secondary:
            revealed?.querySelector(".swipe_action_secondary")?.textContent,
          handoffDuration:
            revealed?.style.getPropertyValue("--swipe-handoff-duration")
        })
      }
      document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }))
      return snapshots
    },
    { distance, waits }
  )
}

function translateX(transform) {
  if (!transform || transform === "none") return 0
  // computed transforms come back as a matrix; tx is the 5th component
  const parts = transform.match(/matrix\(([^)]+)\)/)
  return parts ? Math.round(Number(parts[1].split(",")[4])) : 0
}

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

test("a redirected story remains matched in the Reading view", async ({ page }) => {
  const story = await seedFixtureStories(page)
  const redirectedUrl = await testServerUrl(
    page,
    "/fixtures/articles/redirected.html"
  )

  await openSettingsSection(page, "redirects")
  await page.getByTestId("redirects").fill(
    `${await testServerUrl(page, "/fixtures/article.html")} => ${redirectedUrl}`
  )
  await page.getByTestId("save-redirects").click()
  await page.getByTestId("stories-menu").click()

  const title = story.getByTestId("story-title")
  await expect(title).toHaveAttribute("href", redirectedUrl)
  await title.click()

  await expect(page.locator("#reading_url")).toHaveValue(redirectedUrl)
  await expect(page.getByTestId("reading-current-card")).toBeVisible()
})

test("the current Reading story reflects bookmark changes", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 })
  const story = await seedFixtureStories(page)
  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-open").click()

  const currentCard = page.getByTestId("reading-current-card")
  const collapse = page.getByTestId("reading-story-collapse")
  await expect(currentCard).toBeVisible()
  await page.locator("#reading_story_menu").click()
  await expect(page.getByTestId("story-menu")).toBeVisible()
  await page.getByTestId("story-menu-toggle-bookmark").click()

  await expect(currentCard).toHaveClass(/\bstared\b/)
  await page.locator("#reading_story_menu").click()
  await expect(page.getByTestId("story-menu-toggle-bookmark"))
    .toHaveText("Remove bookmark")
  await page.getByTestId("story-menu-backdrop").click({ position: { x: 5, y: 5 } })

  await expect(collapse).toHaveAttribute("aria-expanded", "true")
  await collapse.click()
  await expect(currentCard).toHaveClass(/\breading_story_collapsed\b/)
  await expect(collapse).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator("#reading_comments")).toBeHidden()
  await expect(page.locator("#reading_type")).toBeVisible()
  await expect(page.locator("#reading_type")).not.toHaveText("")
  await expect(page.locator("#reading_story_time")).toBeHidden()
  await expect(page.locator("#reading_story_tags")).toBeHidden()
  expect(await currentCard.evaluate(
    (card) => card.getBoundingClientRect().height
  )).toBeLessThanOrEqual(40)

  const geometry = await currentCard.evaluate((card) => {
    const cardBox = card.getBoundingClientRect()
    const source = card.querySelector("#reading_type").getBoundingClientRect()
    const title = card.querySelector("#reading_title").getBoundingClientRect()
    const collapseButton = card.querySelector("#reading_story_collapse")
      .getBoundingClientRect()
    const menuButton = card.querySelector("#reading_story_menu")
      .getBoundingClientRect()
    return {
      collapseSize: [collapseButton.width, collapseButton.height],
      menuSize: [menuButton.width, menuButton.height],
      controlsGap: menuButton.left - collapseButton.right,
      contentClearControls: title.right <= collapseButton.left,
      oneLine: [source, title].every(
        (item) => item.top >= cardBox.top && item.bottom <= cardBox.bottom
      ) && Math.abs(
        (source.top + source.bottom) / 2 -
        (title.top + title.bottom) / 2
      ) < 2,
      compactHeight: cardBox.height
    }
  })
  expect(geometry.collapseSize).toEqual([28, 28])
  expect(geometry.menuSize).toEqual([28, 28])
  expect(geometry.controlsGap).toBe(2)
  expect(geometry.contentClearControls).toBe(true)
  expect(geometry.oneLine).toBe(true)
  expect(geometry.compactHeight).toBeLessThanOrEqual(40)

  await page.locator("#reading_type").click()
  await expect(page.locator("#reading_content")).toHaveAttribute(
    "data-mode",
    "comments"
  )
  await expect(currentCard).toHaveClass(/\breading_story_collapsed\b/)
  await expect(page.locator("#reading_title")).toHaveAttribute(
    "aria-label",
    "Open story"
  )

  await page.locator("#reading_title").click()
  await expect(page.locator("#reading_content")).toHaveAttribute(
    "data-mode",
    "browser"
  )
  await expect(currentCard).toHaveClass(/\breading_story_collapsed\b/)

  await collapse.click()
  await expect(currentCard).not.toHaveClass(/\breading_story_collapsed\b/)
  expect(await currentCard.evaluate(
    (card) => card.getBoundingClientRect().height
  )).toBeGreaterThan(40)
  const box = await currentCard.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + 4, { steps: 4 })
  await page.mouse.up()
  await expect(currentCard).toHaveClass(/\breading_story_collapsed\b/)
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
  await page.waitForTimeout(300)
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

test("swipe settings retune action thresholds without a reload", async ({ page }) => {
  const story = await seedFixtureStories(page)

  await openSettingsSection(page, "swipe")
  await setSwipeThreshold(page, 1, 30)
  await page.getByTestId("swipe-right-1").selectOption("toggle-bookmark")
  await waitForSwipeSettings(page)
  await page.waitForTimeout(300)
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
  await page.waitForTimeout(300)
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
  await page.waitForTimeout(300)
  await page.getByTestId("stories-menu").click()

  // The same 35px gesture is outside the low-strength capture band.
  const subtle = await dragStory(story, 35, { release: false })
  expect(translateX(subtle.transform)).toBe(35)
  expect(subtle.action).toBe("none")
  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }))
  })
})

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
  await page.waitForTimeout(300)
  await page.getByTestId("stories-menu").click()

  // A drag well past the old stage-2 threshold stays on stage 1.
  const long = await dragStory(story, 400, { release: false })
  expect(translateX(long.transform)).toBe(400)
  expect(long.action).toBe("open")

  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
})

test("reader TTS bridges through the host when the frame lacks speech synthesis", async ({ page }) => {
  // Simulate the Android WebView reader frame, which has no Web Speech API.
  await page.addInitScript(() => {
    if (window.parent !== window) {
      Object.defineProperty(window, "speechSynthesis", { configurable: true, value: undefined })
      Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: undefined })
    }
  })
  await page.goto("./")
  await openSettingsSection(page, "sources")
  await page.getByTestId("sources").fill(await testServerUrl(page, "/fixtures/feed.rss"))
  await saveSourcesAndWait(page)
  await page.reload()
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()

  const story = page.getByTestId("story").filter({ hasText: "Fixture article" })
  await expect(story).toBeVisible()
  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-open-reader").click()
  await expect(page.locator("#reading_content")).toHaveAttribute("data-mode", "reader")
  const reader = page.locator(".once-reader-host-frame").contentFrame()
  await expect(reader.locator("html")).toHaveAttribute("data-once-tts-installed", "true")
  // the polyfill bridges to the host, so TTS stays available instead of disabled
  await expect(reader.getByTestId("tts-unavailable")).toHaveCount(0)
  await expect(reader.locator("[data-tts-play]")).toBeEnabled()
  await expect(reader.locator("article .tts-segment")).not.toHaveCount(0)
})

test("theme and phone navigation survive orientation changes", async ({ page }) => {
  await page.goto("./")
  await openSettingsSection(page, "theme")
  await page.getByTestId("theme").selectOption("light")
  await expect(page.locator("body")).toHaveAttribute("data-theme", "light")
  await page.setViewportSize({ width: 915, height: 412 })
  await expect(page.getByTestId("stories-menu")).toBeVisible()
  await expect(page.locator("#left_panel")).toHaveCSS("min-width", "0px")
})

test("authenticated PouchDB sync pulls and pushes deterministic settings", async ({
  page,
  request,
  baseURL
}) => {
  const database = "web_sync"
  const server = new URL(baseURL).origin
  await request.post(`${server}/test/databases/${database}/reset`, {
    data: { docs: [{ _id: "theme", list: "light" }] }
  })
  await page.goto("./")
  await openSettingsSection(page, "sync")
  await page.getByTestId("sync-url").fill(
    `${server.replace("http://", "http://once-test:once-test@")}/db/${database}`
  )
  await page.getByTestId("save-sync").click()
  await expect(page.locator("body")).toHaveAttribute("data-theme", "light", { timeout: 15_000 })

  await openSettingsSection(page, "theme")
  await page.getByTestId("theme").selectOption("dark")
  await expect.poll(async () => {
    const response = await request.get(`${server}/db/${database}/theme`, {
      headers: { Authorization: `Basic ${Buffer.from("once-test:once-test").toString("base64")}` }
    })
    return response.ok() ? (await response.json()).list : "pending"
  }, { timeout: 15_000 }).toBe("dark")

  await page.reload()
  await expect(page.locator("body")).toHaveAttribute("data-theme", "dark")
})

test("Reader mode explains failures and offers clean recovery", async ({ page }) => {
  let attempts = 0
  await page.route("**/fixtures/reader-failure*", async (route) => {
    attempts += 1
    if (attempts < 3) {
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "temporarily unavailable"
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><title>Recovered article</title><article>
        <h1>Recovered article</h1>
        <p>${"Reader recovery content. ".repeat(80)}</p>
      </article>`
    })
  })

  await page.goto("./")
  await page.getByTestId("reading-menu").click()
  const url = await testServerUrl(page, "/fixtures/reader-failure")
  await page.getByTestId("reading-url-input").fill(url)
  await page.getByTestId("reading-url-action").click()
  await page.locator("#reading_reader_toggle").click()

  const status = page.getByTestId("reading-reader-status")
  await expect(status).toBeVisible()
  await expect(page.getByTestId("reading-reader-error")).toBeVisible()
  await expect(page.locator("#reading_reader_error_message"))
    .toContainText("HTTP 503")
  await expect(page.getByTestId("reader-tts-bar")).toBeHidden()

  await page.locator("#reading_reader_open_page").click()
  await expect(page.locator("#reading_content")).toHaveAttribute(
    "data-mode",
    "browser"
  )
  await expect(status).toBeHidden()

  await page.locator("#reading_reader_toggle").click()
  await expect(page.getByTestId("reading-reader-error")).toBeVisible()
  await page.locator("#reading_reader_retry").click()
  await expect(page.getByTestId("reading-reader-loading")).toBeVisible()

  const reader = page.locator(".once-reader-host-frame").contentFrame()
  await expect(reader.getByRole("heading", { name: "Recovered article" }))
    .toBeVisible()
  await expect(status).toBeHidden()
  await expect(page.locator("#reading_content")).toHaveAttribute(
    "data-load-state",
    "ready"
  )
  await expect(page.getByTestId("reader-tts-bar")).toBeVisible()
  expect(attempts).toBe(3)
})
