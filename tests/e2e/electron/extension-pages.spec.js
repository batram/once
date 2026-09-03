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
