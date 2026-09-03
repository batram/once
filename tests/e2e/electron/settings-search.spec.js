const { test, expect } = require("@playwright/test")
const { closeApp, launchApp } = require("./electron-harness")

test("searches settings content without changing the open detail", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await window.locator("#left_panel").evaluate((panel) => {
      panel.style.flex = "0 0 900px"
    })
    await expect.poll(() => window.locator("#left_main").evaluate(
      (panel) => panel.getBoundingClientRect().width
    )).toBeGreaterThan(760)

    await window.getByTestId("settings-menu").click()
    await expect.poll(() => window.evaluate(() => {
      const index = document.querySelector("#settings_index")
        .getBoundingClientRect()
      const container = document.querySelector(
        "#settings_panel .settings_container"
      ).getBoundingClientRect()
      return Math.round(container.width - index.width)
    })).toBe(0)
    await window.locator('[data-settings-target="sources"]').click()
    await expect.poll(() => window.locator("#settings_index").evaluate(
      (index) => Math.round(index.getBoundingClientRect().width)
    )).toBe(300)
    const modeToggle = window.getByTestId("sources-mode-toggle")
    await expect(modeToggle).toHaveText("TXT")
    await expect(modeToggle).toHaveAttribute("aria-label", "Edit as text")
    await expect(modeToggle.locator("xpath=..")).toHaveClass(/\bbar\b/)
    await window.getByTestId("sources-mode-toggle").click()
    const search = window.locator("#settings_search")
    const sources = window.locator("#sources_area")
    const rows = window.locator(".settings_section_row")
    const marker = "settings-search-e2e-marker"

    const sourceValue = `first ${marker}\nsecond ${marker}`
    await sources.fill(sourceValue)
    await search.fill(marker)
    await expect(rows.filter({ visible: true })).toHaveCount(1)
    const sourcesResult = window.locator('[data-settings-target="sources"]')
    await expect(sourcesResult).toBeVisible()
    const sourceMatches = sourcesResult.locator("xpath=..")
      .locator(".settings_section_match")
    await expect(sourceMatches).toHaveCount(2)
    await expect(sourceMatches.nth(0)).toContainText(`first ${marker}`)
    await expect(sourceMatches.nth(1)).toContainText(`second ${marker}`)
    await sourceMatches.nth(1).click()
    await expect(sources).toBeVisible()
    await expect(sources).toHaveValue(sourceValue)
    await expect.poll(() => sources.evaluate((element) => ({
      start: element.selectionStart,
      end: element.selectionEnd
    }))).toEqual({
      start: sourceValue.indexOf("second"),
      end: sourceValue.length
    })

    let activeTextarea = sources
    let activeValue = sourceValue
    for (const [target, selector] of [
      ["filters", "#filter_area"],
      ["redirects", "#redirect_area"]
    ]) {
      await search.fill("")
      const row = window.locator(`[data-settings-target="${target}"]`)
      await row.click()
      await window.getByTestId(`${target}-mode-toggle`).click()
      activeTextarea = window.locator(selector)
      activeValue = `first ${marker}-${target}\nsecond ${marker}-${target}`
      await activeTextarea.fill(activeValue)
      await search.fill(`${marker}-${target}`)
      const matches = row.locator("xpath=..").locator(".settings_section_match")
      await expect(matches).toHaveCount(2)
      await matches.nth(1).click()
      await expect.poll(() => activeTextarea.evaluate((element) => ({
        start: element.selectionStart,
        end: element.selectionEnd
      }))).toEqual({
        start: activeValue.indexOf("second"),
        end: activeValue.length
      })
    }

    await search.fill("two-stage")
    await expect(window.locator('[data-settings-target="swipe"]')).toBeVisible()
    await expect(window.locator('[data-settings-target="sources"]')).toBeHidden()
    await expect(activeTextarea).toBeVisible()
    await expect(activeTextarea).toHaveValue(activeValue)

    await window.locator('[data-settings-target="swipe"]').click()
    await expect(window.locator("#swipe_undo_snackbar")).toBeHidden()
    await expect(
      window.locator('[data-settings-target="swipe"]')
    ).toHaveAttribute("aria-current", "page")
    await expect(window.locator(
      '.settings_section[data-settings-section="swipe"]'
    )).toBeVisible()

    await search.fill("mobile undo snackbar")
    await expect(rows.filter({ visible: true })).toHaveCount(0)

    await search.fill("")
    await expect(rows).toHaveCount(13)
    await expect(rows.filter({ visible: true })).toHaveCount(13)

    const errorId = "error-log-settings-search-e2e"
    await window.locator("#error_log").evaluate((log, id) => {
      const entry = document.createElement("details")
      entry.id = id
      entry.className = "error_log_entry"
      entry.tabIndex = -1
      const summary = document.createElement("summary")
      summary.textContent = "Search test error"
      const body = document.createElement("pre")
      body.textContent = "A searchable error detail"
      entry.append(summary, body)
      log.append(entry)
    }, errorId)
    await search.fill("searchable error detail")
    const errorResult = window.locator('[data-settings-target="errors"]')
    await expect(errorResult).toBeVisible()
    await errorResult.locator("xpath=..")
      .locator(".settings_section_match")
      .click()
    const errorEntry = window.locator(`#${errorId}`)
    await expect(errorEntry).toBeVisible()
    await expect(errorEntry).toHaveAttribute("open", "")
    await expect.poll(() => window.evaluate((id) =>
      document.activeElement?.id === id
    , errorId)).toBe(true)

    await search.fill("")
    await window.locator('[data-settings-target="sync"]').click()
    await window.locator("#couch_input").fill(
      "https://user:settings-search-secret@example.test/db"
    )
    await search.fill("settings-search-secret")
    await expect(rows.filter({ visible: true })).toHaveCount(0)
    await expect(window.locator("#settings_search_empty")).toBeVisible()
    await expect(window.locator("#couch_input")).toHaveValue(
      "https://user:settings-search-secret@example.test/db"
    )
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("opens structured entries from settings search results", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await window.getByTestId("settings-menu").click()
    const search = window.locator("#settings_search")

    await search.fill("news?p=2")
    const sourceMatch = window.locator('[data-settings-target="sources"]')
      .locator("xpath=..").locator(".settings_section_match")
    await expect(sourceMatch).toHaveCount(1)
    await sourceMatch.click()
    await expect(window.getByTestId("structured-item-form")).toBeVisible()
    await expect(
      window.getByTestId("structured-item-form").getByLabel("URL", { exact: true })
    ).toHaveValue("https://news.ycombinator.com/news?p=2")

    await window.locator("#settings_section_back").click()
    await window.locator("#settings_section_back").click()
    await search.fill("foxnews.com")
    const filterMatch = window.locator('[data-settings-target="filters"]')
      .locator("xpath=..").locator(".settings_section_match")
    await filterMatch.click()
    const filterInput = window.getByTestId("filter-inline-input")
    await expect(filterInput).toBeVisible()
    await expect(filterInput).toHaveValue("foxnews.com")
    await expect(filterInput.locator("xpath=.."))
      .toHaveClass(/\bstructured_row_target\b/)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("settings menu always resets to a clean section index", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await window.getByTestId("settings-menu").click()
    await window.locator("#settings_search").fill("two-stage")
    await window.locator('[data-settings-target="swipe"]').click()
    await window.getByTestId("stories-menu").click()

    await window.getByTestId("settings-menu").click()

    await expect(window.locator("#settings_panel")).not.toHaveClass(
      /\bsettings_detail_open\b/
    )
    await expect(window.locator(".settings_section.active")).toHaveCount(0)
    await expect(window.locator("#settings_search")).toHaveValue("")
    await expect(window.locator(".settings_section_row")).toHaveCount(13)
    await expect(window.locator(".settings_section_row").filter({
      visible: true
    })).toHaveCount(13)
    await expect(
      window.locator('[data-settings-target="sources"] .settings_section_summary')
    ).toHaveText("5")
    await expect(
      window.locator('[data-settings-target="filters"] .settings_section_summary')
    ).toContainText("keywords")
  } finally {
    await closeApp(electronApp, userData)
  }
})
