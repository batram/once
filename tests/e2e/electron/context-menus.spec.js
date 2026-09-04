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
    // The URL field updates before the remote view has navigated; the page menu below
    // emits on that view's webContents, so wait until it exists at the fixture URL.
    await expect.poll(() => electronApp.evaluate(({ webContents }, expectedUrl) =>
      webContents.getAllWebContents().some((contents) => contents.getURL() === expectedUrl)
    , `${origin}/menus`)).toBe(true)

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
      const point = await window.locator(target.panel).evaluate((panel) => {
        const bounds = panel.getBoundingClientRect()
        return { x: Math.round(bounds.left + 8), y: Math.round(bounds.top + 8) }
      })
      await electronApp.evaluate(({ BrowserWindow }, position) => {
        BrowserWindow.getAllWindows()[0]?.webContents.emit("context-menu", {}, {
          ...position,
          isEditable: false,
          selectionText: "",
          linkURL: "",
          editFlags: {}
        })
      }, point)
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

    await window.locator(".electron-tab").evaluate((tab) => {
      tab.oncontextmenu?.(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 8,
        clientY: 8
      }))
    })
    await expect.poll(() => electronApp.evaluate(() =>
      globalThis.__onceLastMenuTemplate.map((item) => item.label || item.role || item.type)
    )).toEqual([
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

test("keeps tab audio controls until the document navigates", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await window.locator("#urlfield").fill(`${origin}/audio`)
    await window.locator("#urlfield").press("Enter")
    await expect(window.locator("#urlfield")).toHaveValue(`${origin}/audio`)
    await expect.poll(() => electronApp.evaluate(({ webContents }, expectedUrl) =>
      webContents.getAllWebContents().some((contents) => contents.getURL() === expectedUrl)
    , `${origin}/audio`)).toBe(true)

    await electronApp.evaluate(({ Menu, webContents }, expectedUrl) => {
      Menu.buildFromTemplate = (template) => {
        globalThis.__onceLastMenuTemplate = template
        return { popup() {} }
      }
      const remote = webContents.getAllWebContents()
        .find((contents) => contents.getURL() === expectedUrl)
      remote.emit("audio-state-changed", { audible: true })
      remote.emit("audio-state-changed", { audible: false })
    }, `${origin}/audio`)

    const media = window.locator(".electron-tab-media")
    await expect(media).toHaveAttribute("aria-label", "Mute tab")

    await window.locator(".electron-tab").evaluate((tab) => {
      tab.oncontextmenu?.(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 8,
        clientY: 8
      }))
    })
    await expect.poll(() => electronApp.evaluate(() =>
      globalThis.__onceLastMenuTemplate.map((item) => item.label || item.type)
    )).toContain("Mute Tab")

    await electronApp.evaluate(() => {
      globalThis.__onceLastMenuTemplate.find((item) => item.label === "Mute Tab").click()
    })
    await expect(media).toHaveAttribute("aria-label", "Unmute tab")

    await window.locator("#urlfield").fill(`${origin}/after-audio`)
    await window.locator("#urlfield").press("Enter")
    await expect(window.locator("#urlfield")).toHaveValue(`${origin}/after-audio`)
    await expect(media).toHaveCount(0)
    await expect.poll(() => electronApp.evaluate(({ webContents }, expectedUrl) => {
      const remote = webContents.getAllWebContents()
        .find((contents) => contents.getURL() === expectedUrl)
      return remote?.isAudioMuted()
    }, `${origin}/after-audio`)).toBe(false)
  } finally {
    await closeApp(electronApp, userData)
  }
})
