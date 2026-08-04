const { test, expect } = require("@playwright/test")
const { closeApp, launchApp, startPageServer } = require("./electron-harness")

let pageServer
let origin

test.beforeAll(async () => {
  pageServer = await startPageServer()
  origin = pageServer.origin
})

test.afterAll(async () => {
  await pageServer.close()
})

test("enters and leaves fullscreen from an HTML video @interactive", async () => {
  // Window manipulation needs a normal, on-screen window: the background
  // mode used everywhere else parks the window off every monitor, and a
  // maximize restores onto a monitor rather than back to where it was.
  // Safe here because @interactive specs only run on CI.
  const { electronApp, userData, window } = await launchApp({ background: false })
  const videoUrl = `${origin}/video`

  try {
    const address = window.locator("#urlfield")
    await address.fill(videoUrl)
    await address.press("Enter")

    await expect.poll(() => electronApp.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL() === url)
      if (!contents) return false
      return contents.executeJavaScript(`Boolean(
        document.querySelector("#player-frame")?.contentDocument?.querySelector("#test-video")
      )`)
    }, videoUrl)).toBe(true)

    const normalPageBounds = await window.locator("#tab_content").evaluate((element) => {
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
    )).toEqual(normalPageBounds)

    const enterVideoFullscreen = () => electronApp.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL() === url)
      if (!contents) throw new Error(`Missing video page at ${url}`)
      await contents.executeJavaScript(`
        document.querySelector("#player-frame")
          .contentDocument.querySelector("#test-video").requestFullscreen()
      `, true)
    }, videoUrl)

    await enterVideoFullscreen()

    await expect.poll(() => electronApp.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL() === url)
      if (!contents) return null
      return contents.executeJavaScript(`({
        page: document.fullscreenElement?.id || null,
        player: document.querySelector("#player-frame")?.contentDocument?.fullscreenElement?.id || null
      })`)
    }, videoUrl)).toEqual({ page: "player-frame", player: "test-video" })
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isFullScreen()
    )).toBe(true)
    await expect(window.locator("body")).toHaveClass(/electron-fullscreen/)
    await expect(window.locator("#left_panel")).toBeHidden()
    await expect(window.locator("#tab_dropzone")).toBeHidden()
    await expect(window.locator("#controlbar")).toBeHidden()

    await electronApp.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL() === url)
      if (!contents) throw new Error(`Missing video page at ${url}`)
      await contents.executeJavaScript(
        "document.querySelector('#player-frame').contentDocument.exitFullscreen()"
      )
    }, videoUrl)

    await expect.poll(() => electronApp.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL() === url)
      if (!contents) return null
      return contents.executeJavaScript("document.fullscreenElement?.id || null")
    }, videoUrl)).toBe(null)
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isFullScreen()
    )).toBe(false)
    await expect(window.locator("body")).not.toHaveClass(/electron-fullscreen/)
    await expect(window.locator("#left_panel")).toBeVisible()
    await expect(window.locator("#tab_dropzone")).toBeVisible()
    await expect(window.locator("#controlbar")).toBeVisible()
    await expect.poll(() => window.locator("#tab_content").evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    })).toEqual(normalPageBounds)
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.contentView.children[0]?.getBounds()
    )).toEqual(normalPageBounds)

    await electronApp.evaluate(({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL() === url)
      if (!contents) throw new Error(`Missing video page at ${url}`)
      contents.sendInputEvent({ type: "keyDown", keyCode: "F11" })
      contents.sendInputEvent({ type: "keyUp", keyCode: "F11" })
    }, videoUrl)

    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isFullScreen()
    )).toBe(true)
    await expect(window.locator("#left_panel")).toBeHidden()
    await expect(window.locator("#tab_dropzone")).toBeHidden()
    await expect(window.locator("#controlbar")).toBeHidden()

    await electronApp.evaluate(({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL() === url)
      if (!contents) throw new Error(`Missing video page at ${url}`)
      contents.sendInputEvent({ type: "keyDown", keyCode: "F11" })
      contents.sendInputEvent({ type: "keyUp", keyCode: "F11" })
    }, videoUrl)

    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isFullScreen()
    )).toBe(false)
    await expect(window.locator("#left_panel")).toBeVisible()
    await expect(window.locator("#tab_dropzone")).toBeVisible()
    await expect(window.locator("#controlbar")).toBeVisible()
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.contentView.children[0]?.getBounds()
    )).toEqual(normalPageBounds)

    await enterVideoFullscreen()
    await expect.poll(() => electronApp.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL() === url)
      if (!contents) return null
      return contents.executeJavaScript(`({
        page: document.fullscreenElement?.id || null,
        player: document.querySelector("#player-frame")?.contentDocument?.fullscreenElement?.id || null
      })`)
    }, videoUrl)).toEqual({ page: "player-frame", player: "test-video" })

    await electronApp.evaluate(({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL() === url)
      if (!contents) throw new Error(`Missing video page at ${url}`)
      contents.sendInputEvent({ type: "keyDown", keyCode: "Escape" })
      contents.sendInputEvent({ type: "keyUp", keyCode: "Escape" })
    }, videoUrl)

    await expect.poll(() => electronApp.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL() === url)
      if (!contents) return null
      return contents.executeJavaScript("document.fullscreenElement?.id || null")
    }, videoUrl)).toBe(null)
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isFullScreen()
    )).toBe(false)
    await expect(window.locator("#left_panel")).toBeVisible()
    await expect(window.locator("#tab_dropzone")).toBeVisible()
    await expect(window.locator("#controlbar")).toBeVisible()
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.contentView.children[0]?.getBounds()
    )).toEqual(normalPageBounds)
  } finally {
    await closeApp(electronApp, userData)
  }
})
