const { test, expect } = require("@playwright/test")
const {
  closeApp,
  launchApp,
  openSettingsSection
} = require("./electron-harness")

test("reorders story source groups with a native Electron drag", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await openSettingsSection(window, "sources")
    await window.getByTestId("sources-mode-toggle").click()
    const sources = window.locator("#sources_area")
    await expect(sources).toBeVisible()
    await sources.fill([
      "https://example.test/default.xml",
      "*Alpha",
      "https://example.test/alpha.xml",
      "*Beta",
      "https://example.test/beta.xml"
    ].join("\n"))
    const save = window.getByTestId("save-sources")
    await save.click()
    await expect(save).toBeEnabled()
    await window.getByTestId("sources-mode-toggle").click()

    const groups = window.locator(".structured_group")
    const names = window.locator(".structured_group_name")
    await expect(names).toHaveText(["Default", "Alpha", "Beta"])

    const beta = names.nth(2)
    const betaBounds = await beta.boundingBox()
    expect(betaBounds).not.toBeNull()
    await window.mouse.move(
      betaBounds.x + betaBounds.width / 2,
      betaBounds.y + betaBounds.height / 2
    )
    await window.mouse.down()
    await window.mouse.move(
      betaBounds.x + betaBounds.width / 2,
      betaBounds.y + betaBounds.height / 2 + 8,
      { steps: 4 }
    )
    await expect(window.getByTestId("sources-structured-list"))
      .toHaveClass(/\bstructured_group_drag_active\b/)
    const alphaBounds = await groups.nth(1).locator("summary").boundingBox()
    expect(alphaBounds).not.toBeNull()
    await window.mouse.move(
      alphaBounds.x + 12,
      alphaBounds.y + 2,
      { steps: 8 }
    )
    await expect(groups.nth(1)).toHaveClass(
      /\bstructured_group_drop_(before|after)\b/
    )
    await expect.poll(() => groups.nth(1).evaluate((element) => {
      const before = getComputedStyle(element, "::before")
      const after = getComputedStyle(element, "::after")
      return Math.max(
        Number.parseFloat(before.height) || 0,
        Number.parseFloat(after.height) || 0
      )
    })).toBe(3)
    await window.mouse.up()

    await expect(window.locator("body"))
      .not.toHaveClass(/\bwindow-is-receiving-drop\b/)
    await expect.poll(() => window.locator("#titlebar").evaluate((element) =>
      getComputedStyle(element).getPropertyValue("app-region")
    )).toBe("drag")
    await expect(names).toHaveText(["Default", "Beta", "Alpha"])
    const persisted = JSON.parse(await sources.inputValue())
    expect(persisted.groups.map((group) => group.name)).toEqual(["Beta", "Alpha"])
    expect(persisted.sources.map((source) => source.url)).toEqual([
      "https://example.test/default.xml",
      "https://example.test/beta.xml",
      "https://example.test/alpha.xml"
    ])
    expect(persisted.sources.map((source) => source.groupId ?? null)).toEqual([
      null, persisted.groups[0].id, persisted.groups[1].id
    ])
    await expect.poll(() => window.locator("#menu #groups > .button")
      .allTextContents()).toEqual(["*Default", "*Beta", "*Alpha"])

    await window.getByTestId("sources-mode-toggle").click()
    await sources.fill([
      "https://example.test/default.xml",
      "*Beta",
      "https://example.test/beta.xml",
      "*Gamma",
      "https://example.test/alpha.xml"
    ].join("\n"))
    await save.click()
    await expect.poll(() => window.locator("#menu #groups > .button")
      .allTextContents()).toEqual(["*Default", "*Beta", "*Gamma"])
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("keeps a broad auto-scroll zone while dragging settings rows", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await openSettingsSection(window, "filters")
    const rows = window.locator(
      '[data-structured-section="filters"] .structured_row'
    )
    await expect.poll(() => rows.count()).toBeGreaterThan(20)
    const list = window.getByTestId("filters-structured-list")
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const initialScroll = await list.evaluate((element) => element.scrollTop)
    expect(initialScroll).toBeGreaterThan(0)
    await window.getByTestId("filters-structured-list").evaluate((root) => {
      const transfer = new DataTransfer()
      const search = root.querySelector(".structured_search")
        .getBoundingClientRect()
      root.dispatchEvent(new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        clientY: search.bottom + 60,
        dataTransfer: transfer
      }))
    })
    await expect.poll(() => list.evaluate((element) => element.scrollTop))
      .toBeLessThan(initialScroll)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("shows stable insertion indicators while dragging structured rows", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    for (const [section, indicator] of [
      ["sources", "structured_source_drop_before"],
      ["filters", "structured_row_drop_target"],
      ["redirects", "structured_row_drop_target"]
    ]) {
      await openSettingsSection(window, section)
      const rows = window.locator(
        `[data-structured-section="${section}"] .structured_row`
      )
      await expect.poll(() => rows.count()).toBeGreaterThan(1)
      const source = rows.nth(0)
      const target = rows.nth(1)
      const sourceBounds = await source.boundingBox()
      const targetBounds = await target.boundingBox()
      expect(sourceBounds).not.toBeNull()
      expect(targetBounds).not.toBeNull()
      await window.mouse.move(
        sourceBounds.x + sourceBounds.width / 2,
        sourceBounds.y + sourceBounds.height / 2
      )
      await window.mouse.down()
      await window.mouse.move(
        targetBounds.x + targetBounds.width / 2,
        targetBounds.y + 3,
        { steps: 8 }
      )
      await expect(target).toHaveClass(new RegExp(`\\b${indicator}\\b`))
      await expect.poll(() => target.evaluate((element) => {
        const marker = getComputedStyle(element, "::before")
        return Number.parseFloat(marker.height) || 0
      })).toBe(3)
      await window.mouse.up()
    }
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("matches the final-row filter and redirect indicator to the drop", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    for (const section of ["filters", "redirects"]) {
      await openSettingsSection(window, section)
      const rows = window.locator(
        `[data-structured-section="${section}"] .structured_row`
      )
      const rowCount = await rows.count()
      expect(rowCount).toBeGreaterThan(1)
      const source = rows.nth(rowCount - 2)
      const target = rows.nth(rowCount - 1)
      await target.evaluate((element) => {
        element.scrollIntoView({ block: "end" })
      })
      const sourceValue = await source.getAttribute("data-search-value")
      await target.evaluate((element, from) => {
        const transfer = new DataTransfer()
        transfer.setData("text/plain", String(from))
        const bounds = element.getBoundingClientRect()
        element.dispatchEvent(new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          clientY: bounds.bottom - 3,
          dataTransfer: transfer
        }))
      }, rowCount - 2)
      await expect(target).toHaveClass(
        /\bstructured_row_drop_target\b.*\bstructured_row_drop_after\b/
      )
      await expect.poll(() => target.evaluate((element) => {
        const marker = getComputedStyle(element, "::before")
        return {
          bottom: marker.bottom,
          height: Number.parseFloat(marker.height) || 0
        }
      })).toEqual({ bottom: "0px", height: 3 })
      await target.evaluate((element, from) => {
        const transfer = new DataTransfer()
        transfer.setData("text/plain", String(from))
        const bounds = element.getBoundingClientRect()
        element.dispatchEvent(new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientY: bounds.bottom - 3,
          dataTransfer: transfer
        }))
      }, rowCount - 2)
      await expect(rows.nth(rowCount - 1)).toHaveAttribute(
        "data-search-value",
        sourceValue
      )
    }
  } finally {
    await closeApp(electronApp, userData)
  }
})
