const { test, expect } = require("./electron-harness")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const expressPouchDB = require("express-pouchdb")
const { launchApp, closeApp, startPageServer, openSettingsSection } = require("./electron-harness")
const stories = require("../shared/story-fixture")

const otherDevice = "fedcba9876543210fedcba9876543210"

test("a sharing desktop publishes the tabs of both windows, and can remove another device", async () => {
  test.setTimeout(90000)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-tab-sync-"))
  const Db = PouchDB.defaults({ prefix: directory + path.sep })
  const remote = new Db("once")
  await remote.put({
    _id: `dev_${otherDevice}`, type: "device", schema: 1, deviceId: otherDevice, epoch: 1, seq: 4, name: "Test phone",
    platform: "android", appVersion: "1", sharing: true, updatedAt: new Date().toISOString(),
    windows: [{ id: "phone", focused: true, tabs: [] }]
  })
  const api = expressPouchDB(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const http = await new Promise((resolve) => { const server = api.listen(0, "127.0.0.1", () => resolve(server)) })
  const syncUrl = `http://127.0.0.1:${http.address().port}/once`
  const feed = await startPageServer()
  const app = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
  try {
    const page = app.window
    const urls = stories.storyUrls(feed.origin)
    await openSettingsSection(page, "sync", "#couch_input")
    await page.getByTestId("sync-url").fill(syncUrl)
    await page.getByTestId("save-sync").click()
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 20000 })
    const settings = page.getByTestId("tab-sync-settings")
    await expect(settings).toBeVisible()
    await expect(page.getByTestId("tab-sync-device")).toContainText("Test phone")
    await page.getByTestId("device-name").fill("Test desktop")
    await page.getByTestId("device-name").press("Tab")
    await page.getByTestId("tab-sync-share").check()

    await page.evaluate((url) => window.onceElectron.tabs.create(url), urls.alpha)
    await page.evaluate((url) => window.onceElectron.storyMenu.openWindow(url), urls.beta)
    await expect.poll(async () => {
      const devices = (await remote.allDocs({ startkey: "dev_", endkey: "dev_￿", include_docs: true })).rows
        .map((row) => row.doc).filter((doc) => doc.deviceId !== otherDevice)
      return devices.map((doc) => ({ name: doc.name, windows: doc.windows.map((window) => window.tabs.map((tab) => tab.url)) }))
    }, { timeout: 30000 }).toEqual([{ name: "Test desktop", windows: [[urls.alpha], [urls.beta]] }])

    page.once("dialog", (dialog) => dialog.accept())
    await page.getByTestId("tab-sync-device").getByRole("button", { name: "Remove from tab sync" }).click()
    await expect(page.getByTestId("tab-sync-devices")).toContainText("No other devices yet")
    await expect.poll(async () => (await remote.get(`tret_${otherDevice}`).catch(() => null))?.retiredEpoch, { timeout: 20000 }).toBe(1)
    await settings.screenshot({ path: "artifacts/tab-sync/sync-section-electron.png" })
  } finally {
    await closeApp(app.electronApp, app.userData)
    await feed.close()
    http.closeAllConnections()
    await new Promise((resolve) => http.close(resolve))
    await remote.destroy()
  }
})

test("the tab bar button opens other devices' tabs as a page; the side panel can show them instead", async () => {
  test.setTimeout(90000)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-tab-sync-page-"))
  const Db = PouchDB.defaults({ prefix: directory + path.sep })
  const remote = new Db("once")
  const feed = await startPageServer()
  const urls = stories.storyUrls(feed.origin)
  const at = new Date().toISOString()
  const remoteTab = (id, url, title) => ({ id, navSeq: 1, url, title, mode: "web", active: false,
    openedAt: at, navigatedAt: at, selectedAt: at, activityAt: at })
  await remote.put({
    _id: `dev_${otherDevice}`, type: "device", schema: 1, deviceId: otherDevice, epoch: 1, seq: 4, name: "Test phone",
    platform: "android", appVersion: "1", sharing: true, updatedAt: at,
    windows: [{ id: "phone", focused: true, tabs: [remoteTab("a", urls.gamma, "Gamma on the phone"), remoteTab("b", urls.delta, "Delta on the phone")] }]
  })
  const api = expressPouchDB(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const http = await new Promise((resolve) => { const server = api.listen(0, "127.0.0.1", () => resolve(server)) })
  const app = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
  try {
    const page = app.window
    await openSettingsSection(page, "sync", "#couch_input")
    await page.getByTestId("sync-url").fill(`http://127.0.0.1:${http.address().port}/once`)
    await page.getByTestId("save-sync").click()
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 20000 })
    await expect(page.getByTestId("tabs-menu")).toBeHidden()

    await page.getByTestId("tab-sync-button").click()
    const view = await (async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const contents = await app.electronApp.evaluate(({ webContents }) => webContents.getAllWebContents()
          .filter((candidate) => candidate.getURL().startsWith("once-tabs://")).map((candidate) => candidate.id))
        if (contents.length) return contents[0]
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error("The tabs page did not open")
    })()
    const pageText = () => app.electronApp.evaluate(({ webContents }, id) =>
      webContents.fromId(id).executeJavaScript("document.body.innerText"), view)
    await expect.poll(pageText, { timeout: 15000 }).toContain("Gamma on the phone")
    const png = await app.electronApp.evaluate(async ({ webContents }, id) =>
      (await webContents.fromId(id).capturePage()).toPNG().toString("base64"), view)
    await fs.mkdir("artifacts/tab-sync", { recursive: true })
    await fs.writeFile("artifacts/tab-sync/tabs-page-electron.png", Buffer.from(png, "base64"))
    await page.getByTestId("tab-sync-button").click()
    await expect.poll(async () => (await page.evaluate(() => window.onceElectron.tabs.getAll()))
      .filter((tab) => tab.url.startsWith("once-tabs://")).length).toBe(1)

    await app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(
      "[...document.querySelectorAll('.remote_tab_link')].find((link) => link.textContent.includes('Gamma')).click()"), view)
    await expect.poll(async () => (await page.evaluate(() => window.onceElectron.tabs.getAll()))
      .find((tab) => tab.active)?.url).toBe(urls.gamma)

    await page.getByTestId("remote-tabs-placement").selectOption("panel")
    await expect(page.getByTestId("tab-sync-button")).toBeHidden()
    await page.getByTestId("tabs-menu").click()
    await expect(page.getByTestId("tabs-panel")).toBeVisible()
    await expect(page.getByTestId("tabs-panel")).toContainText("Delta on the phone")
    await page.getByTestId("tabs-panel").screenshot({ path: "artifacts/tab-sync/tabs-panel-electron.png" })
  } finally {
    await closeApp(app.electronApp, app.userData)
    await feed.close()
    http.closeAllConnections()
    await new Promise((resolve) => http.close(resolve))
    await remote.destroy()
  }
})
