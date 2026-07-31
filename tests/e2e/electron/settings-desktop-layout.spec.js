const { test, expect } = require("@playwright/test")
const {
  closeApp,
  expectDocumentFocus,
  launchApp,
  openPanel,
  openSettingsSection
} = require("./electron-harness")

test("keeps the story and settings titlebars at the original story height", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const height = (selector) => window.locator(selector).evaluate((element) =>
      Math.round(element.getBoundingClientRect().height)
    )
    const storyHeight = await height("#search_bar")
    const storyCollapse = await window.locator(
      "#search_bar .collapsebutton"
    ).evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
        padding: style.padding,
        font: style.font,
        borderTop: style.borderTop,
        borderBottom: style.borderBottom
      }
    })
    await openPanel(window, "settings")
    const settingsHeight = await height("#settings_panel .panel_titlebar")
    const settingsCollapse = await window.locator(
      "#settings_panel .collapsebutton"
    ).evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
        padding: style.padding,
        font: style.font,
        borderTop: style.borderTop,
        borderBottom: style.borderBottom
      }
    })

    expect({ storyHeight, settingsHeight }).toEqual({
      storyHeight: 39,
      settingsHeight: 39
    })
    expect(settingsCollapse).toEqual(storyCollapse)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("scrolls a new filter editor clear of sticky settings controls", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await openSettingsSection(window, "filters")
    await window.getByTestId("add-filter").click()

    const input = window.getByTestId("filter-inline-input")
    await expectDocumentFocus(input)
    await expect.poll(() => input.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const section = element.closest(".settings_section").getBoundingClientRect()
      const search = element.closest(".structured_settings")
        .querySelector(".structured_search").getBoundingClientRect()
      const actions = element.closest(".settings_editor_block")
        .querySelector(".settings_actions").getBoundingClientRect()
      return {
        belowSearch: bounds.top >= Math.max(section.top, search.bottom),
        aboveActions: bounds.bottom <= Math.min(section.bottom, actions.top)
      }
    })).toEqual({
      belowSearch: true,
      aboveActions: true
    })

    const value = "newly-added-filter.example"
    await input.fill(value)
    await window.getByTestId("save-inline-filter").click()
    const saved = window.locator(`[data-filter-value="${value}"]`)
    const savedRow = saved.locator("xpath=..")
    await expectDocumentFocus(saved)
    await expect.poll(() => savedRow.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const section = element.closest(".settings_section").getBoundingClientRect()
      const search = element.closest(".structured_settings")
        .querySelector(".structured_search").getBoundingClientRect()
      const actions = element.closest(".settings_editor_block")
        .querySelector(".settings_actions").getBoundingClientRect()
      return {
        belowSearch: bounds.top >= Math.max(section.top, search.bottom),
        aboveActions: bounds.bottom <= Math.min(section.bottom, actions.top)
      }
    })).toEqual({
      belowSearch: true,
      aboveActions: true
    })
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("uses the dense desktop source-list geometry and toolbar", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await openSettingsSection(window, "sources")
    await expect(window.getByTestId("add-source")).toBeVisible()
    await expect(window.getByTestId("add-source-group")).toBeVisible()
    await expect(window.getByTestId("pick-source")).toBeVisible()
    await expect.poll(() => window.evaluate(() => {
      const bounds = (selector) =>
        document.querySelector(selector).getBoundingClientRect()
      const statusStrip = document.querySelector(
        '.settings_section[data-settings-section="sources"]' +
        " .structured_status_strip"
      )
      return {
        search: Math.round(bounds(
          '[data-structured-section="sources"] .structured_search input'
        ).height),
        groupHeader: Math.round(bounds(
          '[data-structured-section="sources"] summary'
        ).height),
        row: Math.round(bounds(
          '[data-structured-section="sources"] .structured_row'
        ).height),
        badge: [
          Math.round(bounds(
            '[data-structured-section="sources"] .collector_badge'
          ).width),
          Math.round(bounds(
            '[data-structured-section="sources"] .collector_badge'
          ).height)
        ],
        status: Math.round(statusStrip.getBoundingClientRect().height),
        statusRightInset: Math.round(
          statusStrip.parentElement.getBoundingClientRect().right -
          statusStrip.querySelector(".structured_status_saved")
            .getBoundingClientRect().right
        )
      }
    })).toEqual({
      search: 22,
      groupHeader: 26,
      row: 40,
      badge: [26, 17],
      status: 24,
      statusRightInset: 8
    })
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("keeps every structured desktop editor usable", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    for (const section of ["filters", "redirects"]) {
      await openSettingsSection(window, section)
      const row = window.locator(
        `[data-structured-section="${section}"] .structured_row`
      ).first()
      const body = row.locator(".structured_row_body")
      await expect(row).toBeVisible()
      await expect(body).toBeVisible()
      await expect.poll(() => body.evaluate((element) =>
        Math.round(element.getBoundingClientRect().width)
      )).toBeGreaterThan(200)
    }

    await openSettingsSection(window, "filters")
    await window.getByTestId("add-filter").click()
    const inlineInput = window.getByTestId("filter-inline-input")
    await expect(inlineInput).toBeVisible()
    await expect(window.getByTestId("save-inline-filter")).toBeVisible()
    await expect(
      inlineInput.locator("xpath=..").getByRole("button", { name: "Cancel" })
    ).toBeVisible()
    await expect.poll(() => inlineInput.evaluate((element) =>
      Math.round(element.getBoundingClientRect().width)
    )).toBeGreaterThan(160)

    // One edit surface at a time: opening a row commits and closes whatever
    // was open, rather than leaving two inputs on screen.
    await window.getByTestId("filter-row").first().click()
    await expect(window.getByTestId("filter-inline-input")).toHaveCount(1)
    await window.getByTestId("filter-row").last().click()
    await expect(window.getByTestId("filter-inline-input")).toHaveCount(1)
    await expect(window.locator(".structured_row_editing")).toHaveCount(1)

    await openSettingsSection(window, "sources")
    await window.getByTestId("add-source").click()
    await expect(window.getByTestId("structured-item-form")).toBeVisible()
    await expect(window.getByTestId("structured-save")).toBeVisible()
    await expect(
      window.getByTestId("structured-item-form")
        .getByRole("button", { name: "Cancel" })
    ).toBeVisible()
    await window.getByTestId("structured-item-form")
      .getByRole("button", { name: "Cancel" }).click()
    await expect(window.getByTestId("add-source")).toBeVisible()
    await expect(window.getByTestId("add-source-group")).toBeVisible()
    await expect(window.getByTestId("pick-source")).toBeVisible()

    await openSettingsSection(window, "redirects")
    await window.getByTestId("add-redirect").click()
    await expect(window.getByTestId("structured-save")).toBeVisible()
    await expect(
      window.getByTestId("structured-item-form")
        .getByRole("button", { name: "Cancel" })
    ).toBeVisible()
    await window.getByTestId("structured-item-form")
      .getByRole("button", { name: "Cancel" }).click()
    await expect(window.getByTestId("add-redirect")).toBeVisible()

    // Same rule for the redirect editors, which expand in place on desktop.
    await window.getByTestId("redirect-row").first().click()
    await expect(window.getByTestId("structured-item-form")).toHaveCount(1)
    await window.getByTestId("redirect-row").first().click()
    await expect(window.getByTestId("structured-item-form")).toHaveCount(1)

    await openSettingsSection(window, "sources")
    await window.getByTestId("sources-mode-toggle").click()
    await expect(window.locator(
      ".settings_section[data-settings-section='sources'] .structured_status_strip"
    )).toBeHidden()
    await expect(window.getByTestId("sources")).toBeVisible()
    await expect(window.getByTestId("save-sources")).toBeVisible()
    await expect(window.getByTestId("add-source")).toBeHidden()
    await expect(window.getByTestId("add-source-group")).toBeHidden()
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("opens the desktop source row menu from its hover control", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await openSettingsSection(window, "sources")
    const row = window.getByTestId("source-row").first().locator("xpath=../..")
    await row.hover()
    const menu = row.locator(".structured_row_menu")
    await expect(menu).toBeVisible()
    await menu.click()
    await expect(window.getByRole("menuitem", {
      name: "Edit source"
    })).toBeVisible()
    await expect(window.getByRole("menuitem", {
      name: "Delete source"
    })).toBeVisible()
  } finally {
    await closeApp(electronApp, userData)
  }
})
