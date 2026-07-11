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
  const window = await electronApp.firstWindow()
  await expect
    .poll(() => window.evaluate(() => window.onceElectron.tabs.getAll()))
    .toMatchObject([{ url: "about:blank", active: true }])
  return { electronApp, userData, window }
}

async function closeApp(electronApp, userData) {
  await electronApp.close()
  await fs.rm(userData, { recursive: true, force: true })
}

async function getWindowTabs(electronApp, windowId) {
  return electronApp.evaluate(async ({ BrowserWindow }, id) => {
    const target = BrowserWindow.fromId(id)
    if (!target) throw new Error(`Missing BrowserWindow ${id}`)
    return target.webContents.executeJavaScript(
      "window.onceElectron.tabs.getAll()"
    )
  }, windowId)
}

async function getOnceWindows(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }) =>
    Promise.all(
      BrowserWindow.getAllWindows().map(async (candidate) => ({
        id: candidate.id,
        tabs: await candidate.webContents.executeJavaScript(
          "window.onceElectron.tabs.getAll()"
        ),
      }))
    )
  )
}

async function markLiveContents(electronApp, url) {
  return electronApp.evaluate(async ({ webContents }, targetUrl) => {
    const contents = webContents
      .getAllWebContents()
      .find((candidate) => candidate.getURL() === targetUrl)
    if (!contents) throw new Error(`Missing webContents for ${targetUrl}`)
    await contents.executeJavaScript("window.__onceE2EState = 42")
    return contents.id
  }, url)
}

async function getLiveContentsState(electronApp, contentsId) {
  return electronApp.evaluate(async ({ webContents }, id) => {
    const contents = webContents.fromId(id)
    if (!contents || contents.isDestroyed()) return null
    return {
      url: contents.getURL(),
      state: await contents.executeJavaScript("window.__onceE2EState"),
    }
  }, contentsId)
}

async function transferTab(electronApp, windowId, action, tabId) {
  if (action !== "detach" && action !== "moveHere") {
    throw new Error(`Unsupported tab transfer: ${action}`)
  }
  return electronApp.evaluate(
    async ({ BrowserWindow }, request) => {
      const target = BrowserWindow.fromId(request.windowId)
      if (!target) throw new Error(`Missing BrowserWindow ${request.windowId}`)
      const script = `window.onceElectron.tabs[${JSON.stringify(
        request.action
      )}](${JSON.stringify(request.tabId)})`
      await target.webContents.executeJavaScript(script)
    },
    { windowId, action, tabId }
  )
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
    const detachedUrl = `${origin}/detached`
    const sourceWindowId = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].id
    )

    await window.evaluate(
      (url) => window.onceElectron.tabs.openUrl(url, "blank"),
      detachedUrl
    )
    await expect
      .poll(async () =>
        (await getWindowTabs(electronApp, sourceWindowId)).find(
          (tab) => tab.url === detachedUrl
        )?.title
      )
      .toBe("Detached")

    const liveContentsId = await markLiveContents(electronApp, detachedUrl)
    const sourceTabs = await getWindowTabs(electronApp, sourceWindowId)
    expect(sourceTabs).toHaveLength(2)
    const detachedTab = sourceTabs.find((tab) => tab.url === detachedUrl)
    expect(detachedTab).toMatchObject({ url: detachedUrl, active: true })
    if (!detachedTab) throw new Error("Detached tab was not created")
    const detachedId = detachedTab.id

    await transferTab(electronApp, sourceWindowId, "detach", detachedId)
    const detachedWindows = await getOnceWindows(electronApp)
    expect(detachedWindows).toHaveLength(2)
    expect(
      detachedWindows.find((candidate) => candidate.id === sourceWindowId)?.tabs
    ).toHaveLength(1)
    expect(
      detachedWindows.find((candidate) => candidate.id !== sourceWindowId)?.tabs
    ).toEqual([
      expect.objectContaining({
        id: detachedId,
        url: detachedUrl,
        active: true,
      }),
    ])
    expect(await getLiveContentsState(electronApp, liveContentsId)).toEqual({
      url: detachedUrl,
      state: 42,
    })

    await transferTab(electronApp, sourceWindowId, "moveHere", detachedId)
    await expect
      .poll(async () => (await getOnceWindows(electronApp)).map(({ id }) => id))
      .toEqual([sourceWindowId])

    const restoredTabs = await getWindowTabs(electronApp, sourceWindowId)
    expect(restoredTabs).toHaveLength(2)
    expect(restoredTabs.find((tab) => tab.id === detachedId)).toMatchObject({
      url: detachedUrl,
      active: true,
    })
    expect(await getLiveContentsState(electronApp, liveContentsId)).toEqual({
      url: detachedUrl,
      state: 42,
    })
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
