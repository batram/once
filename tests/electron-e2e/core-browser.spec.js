const { test, expect, _electron: electron } = require("@playwright/test")
const http = require("node:http")
const os = require("node:os")
const path = require("node:path")
const fs = require("node:fs/promises")

let server
let origin

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const name = request.url.slice(1) || "one"
    const title = name.charAt(0).toUpperCase() + name.slice(1)
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(`<!doctype html>
      <title>${title}</title>
      <h1>${title}</h1>
      <a id="page-link" href="${origin || ""}/linked">Linked page</a>
      <input id="page-input" value="editable" />`)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

async function launchApp() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "once-electron-test-"))
  const executablePath = path.resolve(
    __dirname,
    "../../node_modules/electron/dist/electron.exe"
  )
  const appPath = path.resolve(
    __dirname,
    "../../apps/electron/.webpack/x64/main/index.js"
  )
  const electronApp = await electron.launch({
    executablePath,
    args: [appPath],
    env: {
      ...process.env,
      ONCE_ELECTRON_TEST_USER_DATA: userData,
      ONCE_ELECTRON_DISABLE_STORY_LOADING: "1",
      ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "1",
    },
  })
  await expect
    .poll(
      () =>
        electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().length
        ),
      { timeout: 10_000 }
    )
    .toBe(1)
  return { electronApp, userData, window: await electronApp.firstWindow() }
}

async function closeApp(electronApp, userData) {
  await electronApp.close()
  await fs.rm(userData, { recursive: true, force: true })
}

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
        "browser_close",
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
        contentTop: Math.round(content.top),
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
        bridgeType: "undefined",
      })

    const ids = await window.evaluate(() => window.onceElectron.tabs.getAll())
    await window.evaluate(
      ({ id, beforeId }) => window.onceElectron.tabs.reorder(id, beforeId),
      { id: ids[1].id, beforeId: ids[0].id }
    )
    await expect(window.locator(".electron-tab-title").first()).toHaveText("Two")

    await window.locator(".electron-tab").first().dispatchEvent("auxclick", {
      button: 1,
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
          dataTransfer: transfer,
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

test("moves a live tab out to a new Once window and back", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await window.evaluate(
      (url) => window.onceElectron.tabs.openUrl(url, "blank"),
      `${origin}/detached`
    )
    await expect(window.locator(".electron-tab")).toHaveCount(2)
    await window.locator("#browser_popout").click()

    await expect
      .poll(() =>
        electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().length
        )
      )
      .toBe(2)
    let detached
    let source
    await expect
      .poll(async () => {
        let nextDetached
        let nextSource
        for (const candidate of electronApp.windows()) {
          if (!(await candidate.locator("#right_panel").count())) continue
          const tabs = await candidate.evaluate(() => window.onceElectron.tabs.getAll())
          if (tabs.some((tab) => tab.url === `${origin}/detached`)) {
            nextDetached = candidate
          } else if (tabs.length > 0) {
            nextSource = candidate
          }
        }
        if (nextDetached && nextSource) {
          detached = nextDetached
          source = nextSource
          return true
        }
        return false
      })
      .toBe(true)
    await expect(detached.locator(".electron-tab")).toHaveCount(1)
    await expect
      .poll(() =>
        electronApp.evaluate(async ({ BrowserWindow }) => {
          const focused = BrowserWindow.getFocusedWindow()
          if (!focused) return null
          return focused.webContents.executeJavaScript(
            "window.onceElectron.tabs.getAll().then((tabs) => tabs.find((tab) => tab.active)?.url || null)"
          )
        })
      )
      .toBe(`${origin}/detached`)

    const detachedId = await detached.evaluate(async () => {
      const tabs = await window.onceElectron.tabs.getAll()
      return tabs[0].id
    })
    await source.evaluate(
      (id) => window.onceElectron.tabs.moveHere(id),
      detachedId
    )
    await expect
      .poll(() =>
        electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().length
        )
      )
      .toBe(1)
    await expect(source.locator(".electron-tab")).toHaveCount(2)
  } finally {
    await closeApp(electronApp, userData)
  }
})

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
      { menu: "#stories_menu_btn", panel: "#stories_panel" },
    ]) {
      await window.locator(target.menu).click()
      await electronApp.evaluate(() => {
        globalThis.__onceLastMenuTemplate = null
      })
      await window
        .locator(target.panel)
        .click({ button: "right", position: { x: 8, y: 8 } })
      await expect
        .poll(() =>
          electronApp.evaluate(() =>
            globalThis.__onceLastMenuTemplate?.map(
              (item) => item.label || item.role || item.type
            )
          )
        )
        .toEqual(["Inspect"])
    }

    await electronApp.evaluate(() => {
      globalThis.__onceLastMenuTemplate[0].click()
    })
    await expect
      .poll(() =>
        electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.webContents.isDevToolsOpened()
        )
      )
      .toBe(true)
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.closeDevTools()
    })

    await window.locator(".electron-tab").click({ button: "right" })
    const tabLabels = await electronApp.evaluate(() =>
      globalThis.__onceLastMenuTemplate.map((item) => item.label || item.role || item.type)
    )
    expect(tabLabels).toEqual([
      "Inspect",
      "separator",
      "Duplicate Tab",
      "Move Tab to New Window",
      "Close Tab",
    ])

    await electronApp.evaluate(({ webContents }, expectedUrl) => {
      const remote = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === expectedUrl)
      remote.emit("context-menu", {}, {
        x: 4,
        y: 4,
        isEditable: false,
        selectionText: "selected words",
        linkURL: `${expectedUrl}/linked`,
        editFlags: {},
      })
    }, `${origin}/menus`)
    const pageLabels = await electronApp.evaluate(() =>
      globalThis.__onceLastMenuTemplate.map((item) => item.label || item.role || item.type)
    )
    expect(pageLabels).toEqual([
      "Inspect",
      "separator",
      "Copy",
      "Search the Web",
      "separator",
      "Open in New Tab",
      "Open in Background Tab",
      "Open in New Once Window",
      "Open in Default Browser",
      "Copy Link Address",
    ])

    await electronApp.evaluate(({ Menu }) => {
      globalThis.__onceLastMenuTemplate[0].click()
      Menu.buildFromTemplate = globalThis.__onceOriginalBuildFromTemplate
    })
    await expect
      .poll(() =>
        electronApp.evaluate(({ webContents }, expectedUrl) => {
          const remote = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL() === expectedUrl)
          return Boolean(remote && remote.isDevToolsOpened())
        }, `${origin}/menus`)
      )
      .toBe(true)
  } finally {
    await closeApp(electronApp, userData)
  }
})
