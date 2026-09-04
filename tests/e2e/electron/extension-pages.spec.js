const { test, expect } = require("@playwright/test")
const { closeApp, launchApp, startPageServer } = require("./electron-harness")

async function extensionHost(window, name) {
  await expect.poll(() => window.evaluate(async () =>
    (await window.onceElectron.extensions.list()).map((entry) => entry.name)
  ), { timeout: 15_000 }).toContain(name)
  const list = await window.evaluate(() => window.onceElectron.extensions.list())
  return list.find((entry) => entry.name === name).host
}

// Violentmonkey installs a script by cancelling the navigation to a
// `.user.js` URL from a blocking webRequest listener and opening its confirm
// page in a new tab, which then fetches the script across origins and shows
// its metadata. Several runtime pieces have to line up for that one tab.
test("navigating to a userscript opens Violentmonkey's install page", async () => {
  const pageServer = await startPageServer()
  const { electronApp, userData, window } = await launchApp()
  try {
    const host = await extensionHost(window, "Violentmonkey")
    const scriptUrl = `${pageServer.origin}/once-test.user.js`
    await window.evaluate((url) => window.onceElectron.tabs.create(url, true), scriptUrl)

    const confirmPrefix = `moz-extension://${host}/confirm/index.html#`
    await expect.poll(async () =>
      (await window.evaluate(() => window.onceElectron.tabs.getAll()))
        .filter((tab) => tab.url.startsWith(confirmPrefix)).length
    , { timeout: 15_000 }).toBe(1)

    await expect.poll(() => electronApp.evaluate(async ({ webContents }, prefix) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(prefix))
      if (!contents) return ""
      return contents.executeJavaScript("document.body.innerText")
    }, confirmPrefix), { timeout: 15_000 }).toContain("Once Harness Script")
  } finally {
    await closeApp(electronApp, userData)
    await pageServer.close()
  }
})

// uBlock's element picker: the popup's button has the background inject a
// scriptlet that appends an extension frame to the page, and that frame is
// the picker UI, an extension page inside the tab. The page's CSP must not
// refuse the frame, the frame must be served its own scripts and styles, and
// its `browser` must reach the background as a privileged page.
test("the uBlock element picker opens as an extension frame inside the page", async () => {
  const pageServer = await startPageServer()
  const { electronApp, userData, window } = await launchApp()
  try {
    const host = await extensionHost(window, "uBlock Origin")
    const pageUrl = `${pageServer.origin}/strict-frames`
    await window.evaluate((url) => window.onceElectron.tabs.create(url, true), pageUrl)
    await expect.poll(() => electronApp.evaluate(({ webContents }, url) =>
      webContents.getAllWebContents().some((candidate) => candidate.getURL() === url && !candidate.isLoading())
    , pageUrl), { timeout: 15_000 }).toBe(true)

    await window.evaluate((host) =>
      window.onceElectron.extensions.openPopup(host, { x: 600, y: 0, width: 32, height: 32 })
    , host)
    const popupUrl = `moz-extension://${host}/popup-fenix.html`
    await expect.poll(() => electronApp.evaluate(async ({ webContents }, url) => {
      const popup = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(url))
      if (!popup) return false
      return popup.executeJavaScript('document.querySelector("#gotoPick")?.classList.contains("canPick") ?? false')
    }, popupUrl), { timeout: 15_000 }).toBe(true)
    await electronApp.evaluate(async ({ webContents }, url) => {
      const popup = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(url))
      await popup.executeJavaScript('document.querySelector("#gotoPick").click()')
    }, popupUrl)

    // The popup closes itself once the picker is launched.
    await expect.poll(() => electronApp.evaluate(({ webContents }, url) =>
      webContents.getAllWebContents().some((candidate) => candidate.getURL().startsWith(url))
    , popupUrl), { timeout: 15_000 }).toBe(false)

    const pickerPrefix = `moz-extension://${host}/web_accessible_resources/epicker-ui.html`
    await expect.poll(() => electronApp.evaluate(async ({ webContents }, [url, prefix]) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)
      const frame = contents?.mainFrame.frames.find((candidate) => candidate.url.startsWith(prefix))
      if (!frame) return null
      // The frame exists before its own scripts have run, so everything this
      // reads may still be missing. It reports that rather than throwing:
      // an exception in a poll callback ends the poll instead of retrying it.
      return frame.executeJavaScript(`(async () => {
        const sea = document.querySelector("svg#sea > path")
        const dialog = document.querySelector("aside")
        if (typeof vAPI !== "object" || vAPI === null) return { ready: "no vAPI" }
        if (typeof browser !== "object" || browser === null) return { ready: "no browser" }
        if (!sea || !dialog) return { ready: "no picker UI" }
        let hints = "unanswered"
        try {
          hints = typeof (await vAPI.messaging.send("dashboard", { what: "getAutoCompleteDetails" }))
        } catch { /* the background is not listening yet */ }
        return {
          ready: "yes",
          vapi: typeof vAPI,
          manifestName: browser.runtime.getManifest().name,
          stylesLoaded: [...document.querySelectorAll("link[rel=stylesheet]")].every((link) => link.sheet !== null),
          editor: typeof CodeMirror,
          pickButton: document.querySelector("#pick")?.textContent.trim() ?? "",
          // The dimming overlay is the picker's most visible style: with no
          // stylesheet an SVG path fills opaque black and blacks out the page.
          seaFill: getComputedStyle(sea).fill,
          dialogSurface: getComputedStyle(dialog).backgroundColor,
          hints
        }
      })()`)
    }, [pageUrl, pickerPrefix]), { timeout: 30_000 }).toMatchObject({
      ready: "yes",
      vapi: "object",
      manifestName: "uBlock Origin",
      stylesLoaded: true,
      editor: "function",
      pickButton: expect.stringMatching(/\S/),
      seaFill: "rgba(0, 0, 0, 0.5)",
      dialogSurface: expect.stringMatching(/^rgba?\((?!0, 0, 0, 0\))/),
      hints: "object"
    })
  } finally {
    await closeApp(electronApp, userData)
    await pageServer.close()
  }
})

// uBlock's dashboard shows each pane in an iframe of the same extension. That
// frame needs the `browser` object too, and events (port traffic, messages)
// must reach the frame rather than the dashboard around it: the labels come
// from i18n in the frame, the storage line from a round trip to the background.
test("an iframe of an extension page gets the extension API and its messages", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const host = await extensionHost(window, "uBlock Origin")
    const dashboard = `moz-extension://${host}/dashboard.html#settings.html`
    await window.evaluate((url) => window.onceElectron.tabs.create(url, true), dashboard)

    await expect.poll(() => electronApp.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)
      const frame = contents?.mainFrame.frames.find((candidate) => candidate.url.endsWith("/settings.html"))
      if (!frame) return null
      return frame.executeJavaScript(`({
        manifestName: typeof browser?.runtime?.getManifest === "function"
          ? browser.runtime.getManifest().name
          : null,
        chromeIsBrowser: window.chrome === window.browser,
        privacyHeading: document.querySelector('[data-i18n="3pGroupPrivacy"]')?.textContent.trim() ?? "",
        storageLine: document.querySelector("#storageUsed")?.textContent.trim() ?? ""
      })`)
    }, dashboard), { timeout: 15_000 }).toMatchObject({
      manifestName: "uBlock Origin",
      chromeIsBrowser: true,
      privacyHeading: expect.stringMatching(/\S/),
      storageLine: expect.stringMatching(/\d/)
    })

    // Background pages are detached views: the shell window stays the only
    // BrowserWindow, so closing it still quits and menus find the right one.
    expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)

    // uBlock's pane drops its idle port after ten seconds and, in an iframe,
    // treats a disconnect *event* as teardown (vAPI becomes undefined). Its
    // own disconnect() must not echo back, and a new round trip must work.
    await new Promise((resolve) => setTimeout(resolve, 11_000))
    expect(await electronApp.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)
      const frame = contents?.mainFrame.frames.find((candidate) => candidate.url.endsWith("/settings.html"))
      if (!frame) return null
      return frame.executeJavaScript(`(async () => ({
        vapi: typeof vAPI,
        localData: typeof (await vAPI.messaging.send("dashboard", { what: "getLocalData" }))
      }))()`)
    }, dashboard)).toEqual({ vapi: "object", localData: "object" })
  } finally {
    await closeApp(electronApp, userData)
  }
})
