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
