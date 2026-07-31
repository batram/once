const { test, expect } = require("@playwright/test")
const { gotoMobileApp } = require("./helpers/mobile-app")
const { dragAcross, endDrag } = require("./helpers/gestures")
const {
  dragBelowMidpoint,
  openSettingsSection,
  saveSourcesAndWait
} = require("./helpers/settings")

test("structured settings sections do not autofocus search on mobile", async ({
  page
}) => {
  await gotoMobileApp(page)
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
  await gotoMobileApp(page)
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
  const toggleGeometry = await modeToggle.evaluate((toggle) => {
    const bounds = toggle.getBoundingClientRect()
    const before = getComputedStyle(toggle, "::before")
    const after = getComputedStyle(toggle, "::after")
    return {
      innerHeight: bounds.height -
        Number.parseFloat(getComputedStyle(toggle).borderTopWidth) -
        Number.parseFloat(getComputedStyle(toggle).borderBottomWidth),
      beforeHeight: Number.parseFloat(before.height),
      afterHeight: Number.parseFloat(after.height),
      beforeBorderRight: before.borderRightWidth,
      beforeBackground: before.backgroundImage
    }
  })
  expect(toggleGeometry.beforeHeight).toBe(toggleGeometry.innerHeight)
  expect(toggleGeometry.afterHeight).toBe(toggleGeometry.innerHeight)
  expect(toggleGeometry.beforeBorderRight).toBe("0px")
  expect(toggleGeometry.beforeBackground).not.toBe("none")
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
  const sourceScrollIndicator = page.locator(
    '.mobile_scroll_indicator[data-scroll-owner="sources-structured-list"]'
  )
  await expect(sourceScrollIndicator).toBeVisible()
  await expect(sourceList).not.toHaveClass(
    /\bmobile_scrollbar_active\b/,
    { timeout: 1_500 }
  )
  await expect(sourceScrollIndicator).toHaveCSS("opacity", "0")

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

test("filter and redirect after-drop indicators use the final row edge", async ({
  page
}) => {
  await gotoMobileApp(page)
  await openSettingsSection(page, "filters")
  await page.getByTestId("filters-mode-toggle").click()
  const filterRows = page.locator(
    '[data-structured-section="filters"] .structured_row'
  )
  await expect(filterRows).toHaveCount(36)
  await dragAcross(filterRows.nth(0), filterRows.nth(1), {
    on: "target",
    edge: "bottom"
  })
  await expect(filterRows.nth(1)).toHaveClass(/\bstructured_row_drop_target\b/)
  await expect(filterRows.nth(1)).toHaveClass(/\bstructured_row_drop_after\b/)
  const filterIndicator = await filterRows.nth(1).evaluate((row) => {
    const indicator = getComputedStyle(row, "::before")
    return {
      bottom: indicator.bottom,
      top: indicator.top
    }
  })
  expect(Number.parseFloat(filterIndicator.top)).toBeGreaterThan(40)
  expect(filterIndicator.bottom).toBe("-2px")
  await endDrag(filterRows.nth(0))

  await page.locator("#settings_section_back").click()
  await openSettingsSection(page, "redirects")
  await page.getByTestId("redirects").fill(
    "first.example => destination.example/one\n" +
    "second.example => destination.example/two"
  )
  await page.getByTestId("save-redirects").click()
  await page.getByTestId("redirects-mode-toggle").click()
  const redirectRows = page.locator(
    '[data-structured-section="redirects"] .structured_row'
  )
  await expect(redirectRows).toHaveCount(2)
  await dragAcross(redirectRows.nth(0), redirectRows.nth(1), {
    on: "target",
    edge: "bottom"
  })
  await expect(redirectRows.nth(1)).toHaveClass(/\bstructured_row_drop_target\b/)
  await expect(redirectRows.nth(1)).toHaveClass(/\bstructured_row_drop_after\b/)
  await expect(redirectRows.nth(1)).toHaveCSS("box-shadow", "none")
  await endDrag(redirectRows.nth(0))
})

test("filters edit inline and expose a row remove button", async ({ page }) => {
  await gotoMobileApp(page)
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
  const editMetrics = await input.evaluate((field) => {
    const row = field.closest(".structured_row_editing")
    const actions = [...row.querySelectorAll(".structured_inline_action")]
    const centers = actions.map((button) => {
      const glyph = button.firstElementChild
      const buttonRect = button.getBoundingClientRect()
      const glyphRect = glyph.getBoundingClientRect()
      return {
        dx: Math.abs(
          buttonRect.left + buttonRect.width / 2 -
          (glyphRect.left + glyphRect.width / 2)
        ),
        dy: Math.abs(
          buttonRect.top + buttonRect.height / 2 -
          (glyphRect.top + glyphRect.height / 2)
        )
      }
    })
    const divider = getComputedStyle(row, "::after")
    return {
      centers,
      dividerWidth: divider.borderBottomWidth,
      dividerLeft: divider.left
    }
  })
  expect(editMetrics.centers.every(({ dx, dy }) => dx <= 1 && dy <= 1))
    .toBe(true)
  expect(editMetrics.dividerWidth).toBe("1px")
  expect(editMetrics.dividerLeft).toBe("16px")
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
  await gotoMobileApp(page)
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

test("mobile text settings use the detail panel as an editor workspace", async ({ page }) => {
  await gotoMobileApp(page)
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
