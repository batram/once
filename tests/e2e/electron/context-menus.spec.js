const { test, expect } = require("@playwright/test")
const { closeApp, launchApp, startPageServer } = require("./electron-harness")

let pageServer
let origin

test.beforeAll(async () => {
  pageServer = await startPageServer()
  origin = pageServer.origin
})

test.afterAll(async () => pageServer.close())

test("restores native tab and page menus with Inspect in packaged builds", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await window.locator("#urlfield").fill(`${origin}/menus`)
    await window.locator("#urlfield").press("Enter")
    await expect(window.locator("#urlfield")).toHaveValue(`${origin}/menus`)

    await electronApp.evaluate(({ Menu }) => {
      globalThis.__onceOriginalBuildFromTemplate = Menu.buildFromTemplate
      Menu.buildFromTemplate = (template) => {
        globalThis.__onceLastMenuTemplate = template
        return { popup() {} }
      }
    })

    for (const target of [
      { menu: "#settings_menu_btn", panel: "#settings_panel" },
      { menu: "#stories_menu_btn", panel: "#stories_panel" }
    ]) {
      await window.locator(target.menu).click()
      await electronApp.evaluate(() => { globalThis.__onceLastMenuTemplate = null })
      await window.locator(target.panel).click({ button: "right", position: { x: 8, y: 8 } })
      await expect.poll(() => electronApp.evaluate(() =>
        globalThis.__onceLastMenuTemplate?.map((item) => item.label || item.role || item.type)
      )).toEqual(["Inspect"])
    }

    await electronApp.evaluate(() => { globalThis.__onceLastMenuTemplate[0].click() })
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.isDevToolsOpened()
    )).toBe(true)
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.closeDevTools()
    })

    await window.locator(".electron-tab").click({ button: "right" })
    const tabLabels = await electronApp.evaluate(() =>
      globalThis.__onceLastMenuTemplate.map((item) => item.label || item.role || item.type)
    )
    expect(tabLabels).toEqual([
      "Inspect", "separator", "Duplicate Tab", "Move Tab to New Window", "Close Tab"
    ])

    await electronApp.evaluate(({ webContents }, expectedUrl) => {
      const remote = webContents.getAllWebContents().find((contents) => contents.getURL() === expectedUrl)
      remote.emit("context-menu", {}, {
        x: 4,
        y: 4,
        isEditable: false,
        selectionText: "selected words",
        linkURL: `${expectedUrl}/linked`,
        editFlags: {}
      })
    }, `${origin}/menus`)
    const pageLabels = await electronApp.evaluate(() =>
      globalThis.__onceLastMenuTemplate.map((item) => item.label || item.role || item.type)
    )
    expect(pageLabels).toEqual([
      "Inspect", "separator", "Copy", "Search the Web", "separator", "Open in New Tab",
      "Open in Background Tab", "Open in New Once Window", "Open in Default Browser",
      "Copy Link Address"
    ])

    await electronApp.evaluate(({ Menu }) => {
      globalThis.__onceLastMenuTemplate[0].click()
      Menu.buildFromTemplate = globalThis.__onceOriginalBuildFromTemplate
    })
    await expect.poll(() => electronApp.evaluate(({ webContents }, expectedUrl) => {
      const remote = webContents.getAllWebContents().find((contents) => contents.getURL() === expectedUrl)
      return Boolean(remote && remote.isDevToolsOpened())
    }, `${origin}/menus`)).toBe(true)
  } finally {
    await closeApp(electronApp, userData)
  }
})
