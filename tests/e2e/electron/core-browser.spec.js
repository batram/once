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

test("launches a secure browser shell with legacy tab interactions", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await expect(window.locator("#right_panel")).toBeVisible()
    await expect(window.locator(".electron-tab")).toHaveCount(1)

    await expect(window.locator(".electron-tab")).toHaveCSS("min-width", "140px")
    await expect(window.locator(".electron-tab")).toHaveCSS(
      "border-radius",
      "2px 2px 0px 0px"
    )
    await expect(window.locator(".electron-tab-close")).toHaveCSS("opacity", "0")

    const controlBoxes = await window.evaluate(() =>
      [
        "browser_back",
        "browser_forward",
        "urlfield",
        "browser_reload",
        "browser_popout",
        "browser_close"
      ].map((id) => {
        const rect = document.getElementById(id).getBoundingClientRect()
        return { top: Math.round(rect.top), height: Math.round(rect.height) }
      })
    )
    expect(new Set(controlBoxes.map((box) => box.top)).size).toBe(1)
    expect(new Set(controlBoxes.map((box) => box.height))).toEqual(new Set([26]))
    await expect(window.locator("#browser_back svg")).toHaveCount(1)
    await expect(window.locator("#browser_forward svg")).toHaveCount(1)

    const address = window.locator("#urlfield")
    await address.fill("not a valid URL")
    await address.press("Enter")
    await expect(window.locator("#url_error")).toBeVisible()
    await expect(window.locator("#url_error")).toContainText(
      "complete HTTP or HTTPS URL"
    )
    const validationLayout = await window.evaluate(() => {
      const error = document.querySelector("#url_error").getBoundingClientRect()
      const content = document.querySelector("#tab_content").getBoundingClientRect()
      return {
        errorBottom: Math.round(error.bottom),
        contentTop: Math.round(content.top)
      }
    })
    expect(validationLayout.errorBottom).toBeLessThanOrEqual(
      validationLayout.contentTop
    )

    await address.fill(`${origin}/one`)
    await expect(window.locator("#url_error")).toBeHidden()
    await address.press("Enter")
    await expect(address).toHaveValue(`${origin}/one`)

    await window.evaluate(
      (url) => window.onceElectron.tabs.openUrl(url, "middle"),
      `${origin}/two`
    )
    await expect(window.locator(".electron-tab")).toHaveCount(2)
    await expect(address).toHaveValue(`${origin}/one`)

    await expect
      .poll(() =>
        electronApp.evaluate(async ({ webContents }, expectedUrl) => {
          const remote = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL() === expectedUrl)
          if (!remote) return null
          return remote.executeJavaScript(`({
            requireType: typeof require,
            processType: typeof process,
            bridgeType: typeof window.onceElectron
          })`)
        }, `${origin}/two`)
      )
      .toEqual({
        requireType: "undefined",
        processType: "undefined",
        bridgeType: "undefined"
      })

    const ids = await window.evaluate(() => window.onceElectron.tabs.getAll())
    await window.evaluate(
      ({ id, beforeId }) => window.onceElectron.tabs.reorder(id, beforeId),
      { id: ids[1].id, beforeId: ids[0].id }
    )
    await expect(window.locator(".electron-tab-title").first()).toHaveText("Two")

    await window.locator(".electron-tab").first().dispatchEvent("auxclick", {
      button: 1
    })
    await expect(window.locator(".electron-tab")).toHaveCount(1)

    await window.locator("#tab_dropzone").evaluate((element, url) => {
      document.querySelector("#urlfield").blur()
      const transfer = new DataTransfer()
      transfer.setData("text/uri-list", url)
      element.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer
        })
      )
    }, `${origin}/dropped`)
    await expect(window.locator(".electron-tab")).toHaveCount(2)
    await expect(address).toHaveValue(`${origin}/dropped`)

    await window.locator(".electron-tab").last().hover()
    await expect(window.locator(".electron-tab-close").last()).toHaveCSS(
      "opacity",
      "1"
    )
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("clears a stale tab title when the next page has no title", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const address = window.locator("#urlfield")
    const title = window.locator(".electron-tab-title")

    await address.fill(`${origin}/titled`)
    await address.press("Enter")
    await expect(title).toHaveText("Titled")

    await address.fill("about:blank")
    await address.press("Enter")
    await expect(title).toHaveText("New tab")

    await address.fill(`${origin}/titled-again`)
    await address.press("Enter")
    await expect(title).toHaveText("Titled-again")

    await address.fill("http://127.0.0.1:1/unreachable")
    await address.press("Enter")
    await expect(title).toHaveText("New tab")
  } finally {
    await closeApp(electronApp, userData)
  }
})
