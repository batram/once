const { test, expect } = require("@playwright/test")
const { closeApp, launchApp } = require("./electron-harness")

test("keeps the title bar draggable and interactive controls no-drag", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    // The OS handles app-region dragging natively, so synthetic mouse events
    // cannot move the window. Assert the effective region at the points a
    // user would grab instead: the topmost element wins, so this also fails
    // if a no-drag element ever covers the drag area.
    const regionAt = (point) =>
      window.evaluate(({ x, y }) => {
        for (
          let node = document.elementFromPoint(x, y);
          node;
          node = node.parentElement
        ) {
          const region = getComputedStyle(node).getPropertyValue("app-region")
          if (region && region !== "none") return region
        }
        return "none"
      }, point)

    expect(await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMovable()
    )).toBe(true)

    const titlebar = await window.locator("#titlebar").boundingBox()
    expect(titlebar).not.toBeNull()
    await expect.poll(() => regionAt({
      x: titlebar.x + titlebar.width - 20,
      y: titlebar.y + titlebar.height / 2
    })).toBe("drag")

    const newTabButton = await window.locator("#new_tab_btn").boundingBox()
    const tab = await window.locator(".electron-tab").boundingBox()
    await expect.poll(() => regionAt({
      x: newTabButton.x + newTabButton.width + 20,
      y: newTabButton.y + newTabButton.height / 2
    })).toBe("drag")
    await expect.poll(() => regionAt({
      x: newTabButton.x + newTabButton.width / 2,
      y: newTabButton.y + newTabButton.height / 2
    })).toBe("no-drag")
    await expect.poll(() => regionAt({
      x: tab.x + tab.width / 2,
      y: tab.y + tab.height / 2
    })).toBe("no-drag")
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("keeps browser contents within the window after restoring from maximized", async () => {
  test.skip(process.platform !== "win32", "Windows maximize/restore regression")
  const { electronApp, userData, window } = await launchApp()
  try {
    const normalBounds = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds()
    )
    await electronApp.evaluate(({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows()[0]
      target.show()
      target.focus()
      target.maximize()
    })
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMaximized()
    ), { timeout: 10_000 }).toBe(true)

    const viewportWidth = await window.evaluate(() => window.innerWidth)
    const splitter = await window.locator("#sep_slider").boundingBox()
    expect(splitter).not.toBeNull()
    await window.mouse.move(splitter.x + splitter.width / 2, splitter.y + 100)
    await window.mouse.down()
    await window.mouse.move(Math.floor(viewportWidth * 0.8), splitter.y + 100)
    await window.mouse.up()

    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].unmaximize()
    )
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMaximized()
    )).toBe(false)
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds()
    )).toEqual(normalBounds)

    await expect.poll(() => window.evaluate(() => {
      const right = document.querySelector("#right_panel").getBoundingClientRect()
      const content = document.querySelector("#tab_content").getBoundingClientRect()
      return {
        fillsViewport: Math.round(right.right) === window.innerWidth,
        content: {
          x: Math.round(content.x),
          y: Math.round(content.y),
          width: Math.round(content.width),
          height: Math.round(content.height)
        }
      }
    })).toMatchObject({
      fillsViewport: true
    })

    const contentBounds = await window.locator("#tab_content").evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    })
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.contentView.children[0]?.getBounds()
    )).toEqual(contentBounds)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("keeps the icon rail and restores either sidebar panel", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const collapse = window.locator("#stories_panel .collapsebutton")
    const dividerGap = await window.evaluate(() => {
      const button = document
        .querySelector("#stories_panel .collapsebutton")
        .getBoundingClientRect()
      const divider = document.querySelector("#sep_slider").getBoundingClientRect()
      return Math.round(divider.left - button.right)
    })
    expect(dividerGap).toBe(0)

    await collapse.click()
    await expect(window.locator("#left_panel")).toBeVisible()
    await expect(window.locator("#left_main")).toBeHidden()
    await expect(window.locator("#menu")).toBeVisible()
    await expect(window.locator("#menu")).toHaveClass(/\bcollapse\b/)
    await expect(window.locator("#left_panel")).toHaveCSS("width", "30px")
    await expect(window.locator("#browser_sidebar_toggle")).toHaveCount(0)

    if (process.platform === "darwin") {
      const firstTabLeft = await window.locator(".electron-tab").first()
        .evaluate((element) => Math.round(element.getBoundingClientRect().left))
      expect(firstTabLeft).toBeGreaterThanOrEqual(78)
    }

    await window.getByTestId("settings-menu").click()
    await expect(window.locator("#left_main")).toBeVisible()
    await expect(window.locator("#menu")).not.toHaveClass(/\bcollapse\b/)
    await expect(window.locator("#left_panel")).toHaveAttribute(
      "active_panel",
      "settings"
    )

    const settingsHeader = await window.evaluate(() => {
      const title = document.querySelector("#settings_panel .settings_title")
        .getBoundingClientRect()
      const collapse = document.querySelector(
        "#settings_panel .collapsebutton"
      ).getBoundingClientRect()
      const divider = document.querySelector("#sep_slider").getBoundingClientRect()
      return {
        titleRight: Math.round(title.right),
        collapseLeft: Math.round(collapse.left),
        dividerGap: Math.round(divider.left - collapse.right)
      }
    })
    expect(settingsHeader.titleRight).toBeLessThan(settingsHeader.collapseLeft)
    expect(settingsHeader.dividerGap).toBe(0)

    await window.locator('[data-settings-target="filters"]').click()
    const detailHeader = await window.evaluate(() => {
      const back = document.querySelector("#settings_section_back")
        .getBoundingClientRect()
      const title = document.querySelector("#settings_panel .settings_title")
        .getBoundingClientRect()
      const collapse = document.querySelector(
        "#settings_panel .collapsebutton"
      ).getBoundingClientRect()
      return {
        backRight: Math.round(back.right),
        titleLeft: Math.round(title.left),
        titleRight: Math.round(title.right),
        collapseLeft: Math.round(collapse.left)
      }
    })
    expect(detailHeader.backRight).toBeLessThanOrEqual(detailHeader.titleLeft)
    expect(detailHeader.titleRight).toBeLessThan(detailHeader.collapseLeft)

    await window.locator("#settings_panel .collapsebutton").click()
    await expect(window.locator("#left_main")).toBeHidden()
    await window.getByTestId("stories-menu").click()
    await expect(window.locator("#left_main")).toBeVisible()
    await expect(window.locator("#left_panel")).toHaveAttribute(
      "active_panel",
      "stories"
    )
  } finally {
    await closeApp(electronApp, userData)
  }
})
