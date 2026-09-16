const { test, expect } = require("./electron-harness")
const {
  closeApp,
  launchApp,
  seedLocalSource,
  startPageServer
} = require("./electron-harness")
const storyFixture = require("../shared/story-fixture")

test("keeps the title bar draggable and interactive controls no-drag @interactive", async () => {
  // Window manipulation needs a normal, on-screen window: the background
  // mode used everywhere else parks the window off every monitor, and a
  // maximize restores onto a monitor rather than back to where it was.
  // Safe here because @interactive specs only run on CI.
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp({
    background: false,
    // Seeded stories arrive through the renderer fetch bridge.
    env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" }
  })
  try {
    // The OS handles app-region dragging natively, so synthetic mouse events
    // cannot move the window, and the native region is not readable from
    // here. Chromium builds it as the union of every `drag` box minus the
    // union of every `no-drag` box, ignoring stacking, overflow clipping and
    // scroll position. So a hit test at a point cannot prove anything; the
    // invariant is that no element outside the two bars carries a region at
    // all. A no-drag row scrolled under the title bar would otherwise carve
    // a hole in it (browser tabs on 2026-09-14, story trays after that).
    const BARS = ["#titlebar", "#tab_dropzone"]
    const strayRegions = () =>
      window.evaluate((bars) => {
        const strays = []
        for (const node of document.querySelectorAll("*")) {
          const region = getComputedStyle(node).getPropertyValue("app-region")
          if (!region || region === "none") continue
          if (bars.some((selector) => node.closest(selector))) continue
          const id = node.id ? `#${node.id}` : ""
          const classes = node.className && typeof node.className === "string"
            ? `.${node.className.trim().split(/\s+/).join(".")}`
            : ""
          strays.push(`${node.tagName.toLowerCase()}${id}${classes}: ${region}`)
        }
        return strays
      }, BARS)
    const regionOf = (selector) =>
      window.locator(selector).evaluate((node) =>
        getComputedStyle(node).getPropertyValue("app-region")
      )

    expect(await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMovable()
    )).toBe(true)
    await expect(window.locator("#reading_menu_btn")).toBeHidden()

    // The bars opt in, their controls opt out, and the tabs themselves carry
    // nothing so a scrolled-out tab cannot subtract from the title bar.
    await expect.poll(() => regionOf("#titlebar")).toBe("drag")
    await expect.poll(() => regionOf("#tab_dropzone")).toBe("drag")
    await expect.poll(() => regionOf("#new_tab_btn")).toBe("no-drag")
    await expect.poll(() => regionOf("#electron_tabs")).toBe("no-drag")
    await expect.poll(() => regionOf(".electron-tab")).toBe("none")
    expect(await strayRegions()).toEqual([])

    // Real story rows, then a list too short for them so rows sit under the
    // title bar's box. The invariant must not depend on scroll state.
    await seedLocalSource(
      window,
      storyFixture.rssSourceLine(server.origin),
      storyFixture.storyUrls(server.origin).alpha
    )
    const stories = window.locator("#stories")
    await stories.evaluate((element) => {
      element.style.maxHeight = "60px"
      element.scrollTop = element.scrollHeight
    })
    await expect.poll(() => stories.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    expect(await strayRegions()).toEqual([])
    expect(await regionOf("#titlebar")).toBe("drag")
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("keeps browser contents within the window after restoring from maximized @interactive", async () => {
  test.skip(process.platform !== "win32", "Windows maximize/restore regression")
  // Window manipulation needs a normal, on-screen window: the background
  // mode used everywhere else parks the window off every monitor, and a
  // maximize restores onto a monitor rather than back to where it was.
  // Safe here because @interactive specs only run on CI.
  const { electronApp, userData, window } = await launchApp({ background: false })
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
      BrowserWindow.getAllWindows()[0]?.contentView.children.find((view) => view.getVisible())?.getBounds()
    )).toEqual(contentBounds)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("keeps the icon rail and restores either sidebar panel @interactive", async () => {
  // Window manipulation needs a normal, on-screen window: the background
  // mode used everywhere else parks the window off every monitor, and a
  // maximize restores onto a monitor rather than back to where it was.
  // Safe here because @interactive specs only run on CI.
  const { electronApp, userData, window } = await launchApp({ background: false })
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
