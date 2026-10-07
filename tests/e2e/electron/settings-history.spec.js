const { test, expect, launchApp, closeApp, openSettingsSection } = require("./electron-harness")

async function mouseHistory(window, direction) {
  const cdp = await window.context().newCDPSession(window)
  try {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: direction, buttons: direction === "back" ? 8 : 16, x: 170, y: 150, clickCount: 1 })
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: direction, buttons: 0, x: 170, y: 150, clickCount: 1 })
  } finally { await cdp.detach() }
}

test("all settings subpages reopen with Forward and keep drafts across section visits", async () => {
  test.setTimeout(60_000)
  const { electronApp, userData, window } = await launchApp()
  try {
    const back = window.locator("#settings_section_back")
    const roundTrip = async (open, page, draft) => {
      await open()
      await expect(page).toBeVisible()
      if (draft) await draft.control.fill(draft.value)
      await back.click()
      await expect(page).toBeHidden()
      await mouseHistory(window, "forward")
      await expect(page).toBeVisible()
      if (draft) await expect(draft.control).toHaveValue(draft.value)
      await mouseHistory(window, "back")
      await expect(page).toBeHidden()
    }
    await openSettingsSection(window, "sync")
    for (const target of ["tabs", "pair", "addons"]) {
      await roundTrip(() => window.locator(`[data-sync-target="${target}"]`).click(), window.locator(`[data-sync-page="${target}"]`))
    }
    await openSettingsSection(window, "addons")
    await roundTrip(() => window.getByTestId("open-addon-import").click(), window.locator("#addon_import"),
      { control: window.getByTestId("addon-url"), value: "https://example.test/unfinished-addon.json" })
    await roundTrip(() => window.getByTestId("open-addon-advanced").click(), window.locator("#addon_advanced"),
      { control: window.getByTestId("addons"), value: "unfinished JSON draft" })
    await window.getByTestId("open-addon-advanced").click()
    await window.getByTestId("addons").fill(JSON.stringify([{ protocol: 1, id: "history-addon", name: "History addon", version: "1.0.0", contributions: [],
      settings: { type: "object", properties: { prompt: { type: "string", format: "multiline", default: "Default" } } } }]))
    await window.getByTestId("save-addons").click()
    await back.click()
    await roundTrip(() => window.locator('.addon_list_row[data-addon-id="history-addon"]').click(),
      window.getByTestId("addon-option-history-addon-prompt"))
    await openSettingsSection(window, "extensions")
    await roundTrip(() => window.getByRole("button", { name: "Install extension", exact: true }).click(), window.locator("#browser-extension-source"),
      { control: window.locator("#browser-extension-source"), value: "https://example.test/unfinished-extension.xpi" })
    await window.getByRole("button", { name: "Filter lists & userscripts", exact: true }).click()
    await roundTrip(() => window.getByTestId("add-userscript").click(), window.locator(".userscript_detail"),
      { control: window.getByTestId("userscript-source"), value: "unfinished userscript draft" })
    await roundTrip(() => window.getByTestId("edit-userscripts-text").click(), window.locator("#userscripts_bulk"),
      { control: window.locator("#userscripts_area"), value: "unfinished bulk draft" })

    // A real third level: extension overview -> detail -> storage selection.
    await openSettingsSection(window, "extensions")
    await window.locator(".browser_extension_row").first().click()
    await roundTrip(() => window.getByRole("button", { name: "Choose settings to sync", exact: true }).click(),
      window.getByRole("button", { name: "Save sync selection", exact: true }))

    // Back from another section restores the precise page, then Forward
    // returns to that other section rather than reopening a cached editor.
    await window.getByRole("button", { name: "Choose settings to sync", exact: true }).click()
    await window.locator("#left_panel").evaluate(panel => { panel.style.flex = "0 0 900px" })
    await window.locator('[data-settings-target="sync"]').click()
    await expect(window.locator('[data-sync-page="overview"]')).toBeVisible()
    await mouseHistory(window, "back")
    await expect(window.getByRole("button", { name: "Save sync selection", exact: true })).toBeVisible()
    await mouseHistory(window, "forward")
    await expect(window.locator('[data-sync-page="overview"]')).toBeVisible()
  } finally { await closeApp(electronApp, userData) }
})

test("leaving shortcut capture releases the keyboard and Forward reopens the section", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await openSettingsSection(window, "keyboard")
    await window.getByTestId("keybinding-history.undo-0").click()
    await expect(window.locator(".keybinding_slot--capturing")).toHaveCount(1)
    await mouseHistory(window, "back")
    await expect(window.locator(".keybinding_slot--capturing")).toHaveCount(0)
    await window.locator("#settings_search").fill("sync")
    await expect(window.locator("#settings_search")).toHaveValue("sync")
    await mouseHistory(window, "forward")
    await expect(window.locator('.settings_section[data-settings-section="keyboard"]')).toBeVisible()
    await expect(window.locator(".keybinding_slot--capturing")).toHaveCount(0)
  } finally { await closeApp(electronApp, userData) }
})

test("structured row and text drafts replay through the same history and Cancel retires them", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    for (const [section, add] of [["sources", "add-source"], ["sources", "add-source-group"], ["filters", "add-filter"]]) {
      await openSettingsSection(window, section)
      await window.getByTestId(add).click()
      const editor = section === "sources" ? window.getByTestId("structured-item-form") : window.locator(".structured_row_editing")
      const input = editor.locator("input:not([type=checkbox]), textarea").first()
      await input.fill(section === "sources" ? "Unfinished source" : "unfinished filter")
      await mouseHistory(window, "back")
      await expect(editor).toHaveCount(0)
      await mouseHistory(window, "forward")
      await expect(input).toHaveValue(section === "sources" ? "Unfinished source" : "unfinished filter")
      if (section === "sources") {
        await window.getByTestId("sources-mode-toggle").click()
        await window.locator("#sources_area").fill("another unfinished text draft")
        await mouseHistory(window, "back")
        await expect(input).toHaveValue("Unfinished source")
        await mouseHistory(window, "forward")
        await expect(window.locator("#sources_area")).toHaveValue("another unfinished text draft")
        await mouseHistory(window, "back")
      }
      await editor.getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(window.getByTestId(add)).toBeVisible()
      await mouseHistory(window, "forward")
      await expect(editor).toHaveCount(0)
      await window.getByTestId(`${section}-mode-toggle`).click()
      const text = window.locator(section === "sources" ? "#sources_area" : "#filter_area")
      await text.fill(`unfinished ${section} text`)
      await mouseHistory(window, "back")
      await expect(text).toBeHidden()
      await mouseHistory(window, "forward")
      await expect(text).toHaveValue(`unfinished ${section} text`)
    }
  } finally { await closeApp(electronApp, userData) }
})
