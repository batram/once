const { test, expect } = require("./electron-harness")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const expressPouchDB = require("express-pouchdb")
const { launchApp, closeApp, startPageServer, openSettingsSection } = require("./electron-harness")
const stories = require("../shared/story-fixture")
const { startMediaServer } = require("../shared/media-server")

const otherDevice = "fedcba9876543210fedcba9876543210"
// Publish within a fraction of a second rather than the real 3 s debounce and 15 s interval.
const QUICK_PUBLISHING = JSON.stringify({ debounce: 100, minInterval: 300 })

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
  const app = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0", ONCE_ELECTRON_TABSYNC_TIMING: QUICK_PUBLISHING } })
  try {
    const page = app.window
    const urls = stories.storyUrls(feed.origin)
    await openSettingsSection(page, "sync", "#couch_input")
    await page.getByTestId("sync-url").fill(syncUrl)
    await page.getByTestId("save-sync").click()
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 20000 })
    // Tab sync is off until the first-run offer is taken; Share turns sharing on with it.
    await expect(page.getByTestId("sync-page-tabs")).toContainText("Off")
    await page.getByTestId("tab-sync-offer-share").click()
    await expect(page.getByTestId("tab-sync-offer")).toBeHidden()
    await page.getByTestId("device-name").fill("Test desktop")
    await page.getByTestId("device-name").press("Tab")
    await page.getByTestId("sync-page-tabs").click()
    const settings = page.getByTestId("tab-sync-settings")
    await expect(settings).toBeVisible()
    await expect(page.getByTestId("tab-sync-enabled")).toBeChecked()
    await expect(page.getByTestId("tab-sync-share")).toBeChecked()
    await expect(page.getByTestId("tab-sync-device")).toContainText("Test phone")

    await page.evaluate((url) => window.onceElectron.tabs.create(url), urls.alpha)
    await page.evaluate((url) => window.onceElectron.storyMenu.openWindow(url), urls.beta)
    await expect.poll(async () => {
      const devices = (await remote.allDocs({ startkey: "dev_", endkey: "dev_￿", include_docs: true })).rows
        .map((row) => row.doc).filter((doc) => doc.deviceId !== otherDevice)
      return devices.map((doc) => ({ name: doc.name, windows: doc.windows.map((window) => window.tabs.map((tab) => tab.url)) }))
    }, { timeout: 30000 }).toEqual([{ name: "Test desktop", windows: [[urls.alpha], [urls.beta]] }])
    // Each tab's screenshot follows, stored once under its own record.
    await expect.poll(async () => {
      const [desktop] = (await remote.allDocs({ startkey: "dev_", endkey: "dev_\uffff", include_docs: true })).rows
        .map((row) => row.doc).filter((doc) => doc.deviceId !== otherDevice)
      const thumbs = desktop.windows.flatMap((window) => window.tabs.map((tab) => tab.thumb?.id)).filter(Boolean)
      const stored = await Promise.all(thumbs.map((id) => remote.getAttachment(id.split("#")[0], "thumb.jpg").then((data) => data.length > 500, () => false)))
      return stored.filter(Boolean).length
    }, { timeout: 30000 }).toBe(2)
    const [shot] = (await remote.allDocs({ startkey: "tth_", endkey: "tth_\uffff" })).rows
    await fs.mkdir("artifacts/tab-sync", { recursive: true })
    await fs.writeFile("artifacts/tab-sync/published-thumb-electron.jpg", await remote.getAttachment(shot.id.split("#")[0], "thumb.jpg"))

    await page.getByTestId("tab-sync-device").getByRole("button", { name: "Remove Test phone from tab sync" }).click()
    await page.getByTestId("confirm-accept").click()
    await expect(page.getByTestId("tab-sync-devices")).toContainText("No other devices yet")
    await expect.poll(async () => (await remote.get(`tret_${otherDevice}`).catch(() => null))?.retiredEpoch, { timeout: 20000 }).toBe(1)
    await page.locator("#sync_page_tabs").screenshot({ path: "artifacts/tab-sync/sync-section-electron.png" })

    // Off, nothing of tab sync shows and this device's record goes.
    await page.getByTestId("tab-sync-enabled").uncheck()
    await expect(page.getByTestId("tab-sync-button")).toBeHidden()
    await expect.poll(async () => (await remote.allDocs({ startkey: "dev_", endkey: "dev_\uffff" })).rows.length, { timeout: 20000 }).toBe(0)
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
  const api = expressPouchDB(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const http = await new Promise((resolve) => { const server = api.listen(0, "127.0.0.1", () => resolve(server)) })
  const app = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0", ONCE_ELECTRON_TABSYNC_TIMING: QUICK_PUBLISHING } })
  try {
    // A real JPEG for the screenshot, made by Electron itself.
    const jpeg = await app.electronApp.evaluate(({ nativeImage }) => nativeImage
      .createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
      .toJPEG(80).toString("base64"))
    const thumbId = `tth_${otherDevice}_${"a".repeat(40)}`
    await remote.put({ _id: thumbId, type: "thumb", deviceId: otherDevice, width: 1, height: 1, createdAt: at,
      _attachments: { "thumb.jpg": { content_type: "image/jpeg", data: jpeg } } })
    await remote.put({
      _id: `dev_${otherDevice}`, type: "device", schema: 1, deviceId: otherDevice, epoch: 1, seq: 4, name: "Test phone",
      platform: "android", appVersion: "1", sharing: true, updatedAt: at,
      windows: [{ id: "phone", focused: true, tabs: [{ ...remoteTab("a", urls.gamma, "Gamma on the phone"), thumb: { id: thumbId, w: 1, h: 1 } }, remoteTab("b", urls.delta, "Delta on the phone")] }]
    })
    const page = app.window
    await openSettingsSection(page, "sync", "#couch_input")
    await page.getByTestId("sync-url").fill(`http://127.0.0.1:${http.address().port}/once`)
    await page.getByTestId("save-sync").click()
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 20000 })
    await expect(page.getByTestId("tab-sync-button")).toBeHidden()
    await page.getByTestId("tab-sync-offer-see").click()
    await expect(page.getByTestId("tabs-menu")).toBeHidden()

    await page.getByTestId("tab-sync-button").click()
    await expect(page.getByTestId("tab-sync-button")).toHaveAttribute("aria-pressed", "true")
    await expect(page.locator("#electron_tabs .electron-tab", { hasText: "Tabs from other devices" })).toHaveCount(0)
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
    await expect.poll(() => app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(
      "[...document.querySelectorAll('.remote_tab_preview img')].filter((image) => !image.hidden && image.naturalWidth > 0).length"), view),
    { timeout: 15000 }).toBe(1)
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
    await expect(page.getByTestId("tab-sync-button")).toHaveAttribute("aria-pressed", "false")

    await page.getByTestId("sync-page-tabs").click()
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

test("a media position is read when its tab is left, and restored when another device opens it", async () => {
  test.setTimeout(90000)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-tab-sync-media-"))
  const Db = PouchDB.defaults({ prefix: directory + path.sep })
  const remote = new Db("once")
  const media = await startMediaServer()
  const at = new Date().toISOString()
  await remote.put({
    _id: `dev_${otherDevice}`, type: "device", schema: 1, deviceId: otherDevice, epoch: 1, seq: 4, name: "Test phone",
    platform: "android", appVersion: "1", sharing: true, updatedAt: at,
    windows: [{ id: "phone", focused: true, tabs: [{ id: "a", navSeq: 1, url: `${media.origin}/listen?remote`, title: "Listening on the phone",
      mode: "web", active: true, openedAt: at, navigatedAt: at, selectedAt: at, activityAt: at,
      state: { media: { v: 1, capturedAt: at, data: { currentTime: 33, duration: 60, paused: true, rate: 1 } } } }] }]
  })
  const api = expressPouchDB(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const http = await new Promise((resolve) => { const server = api.listen(0, "127.0.0.1", () => resolve(server)) })
  const app = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0", ONCE_ELECTRON_TABSYNC_TIMING: QUICK_PUBLISHING } })
  const inTab = (url, script) => app.electronApp.evaluate(({ webContents }, [target, source]) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === target)
    return contents ? contents.executeJavaScript(source) : null
  }, [url, script])
  try {
    const page = app.window
    await openSettingsSection(page, "sync", "#couch_input")
    await page.getByTestId("sync-url").fill(`http://127.0.0.1:${http.address().port}/once`)
    await page.getByTestId("save-sync").click()
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 20000 })
    await page.getByTestId("tab-sync-offer-share").click()
    // Turning tab sync on restarts publishing; the tabs are used once it is under way.
    await expect.poll(async () => (await remote.allDocs({ startkey: "dev_", endkey: "dev_\uffff", include_docs: true })).rows
      .some((row) => row.doc.deviceId !== otherDevice && row.doc.sharing), { timeout: 20000 }).toBe(true)

    const listening = `${media.origin}/listen`
    await page.evaluate((url) => window.onceElectron.tabs.create(url), listening)
    await expect.poll(() => inTab(listening, "document.querySelector('audio')?.duration || 0"), { timeout: 15000 }).toBeGreaterThan(50)
    await inTab(listening, "document.querySelector('audio').currentTime = 12")
    // Leaving the tab is when its position is read.
    await page.evaluate((url) => window.onceElectron.tabs.create(url), `${media.origin}/elsewhere`)
    await expect.poll(async () => {
      const [desktop] = (await remote.allDocs({ startkey: "dev_", endkey: "dev_￿", include_docs: true })).rows
        .map((row) => row.doc).filter((doc) => doc.deviceId !== otherDevice)
      const tab = desktop?.windows.flatMap((window) => window.tabs).find((item) => item.url === listening)
      return Math.round(tab?.state?.media?.data.currentTime ?? -1)
    }, { timeout: 30000 }).toBe(12)

    await page.getByTestId("tab-sync-button").click()
    await expect.poll(() => app.electronApp.evaluate(({ webContents }) => webContents.getAllWebContents()
      .some((candidate) => candidate.getURL().startsWith("once-tabs://"))), { timeout: 10000 }).toBe(true)
    const tabsPage = await app.electronApp.evaluate(({ webContents }) => webContents.getAllWebContents()
      .find((candidate) => candidate.getURL().startsWith("once-tabs://")).id)
    await expect.poll(() => app.electronApp.evaluate(({ webContents }, id) =>
      webContents.fromId(id).executeJavaScript("document.body.innerText"), tabsPage), { timeout: 15000 }).toContain("0:33 / 1:00")
    await app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(
      "[...document.querySelectorAll('.remote_tab_link')].find((link) => link.textContent.includes('Listening on the phone')).click()"), tabsPage)
    await expect.poll(() => inTab(`${media.origin}/listen?remote`, "Math.round(document.querySelector('audio')?.currentTime ?? -1)"),
      { timeout: 20000 }).toBe(33)
  } finally {
    await closeApp(app.electronApp, app.userData)
    await media.close()
    http.closeAllConnections()
    await new Promise((resolve) => http.close(resolve))
    await remote.destroy()
  }
})

test("a tab sent here shows as a toast and opens; the tab just used on another device is offered to continue", async () => {
  test.setTimeout(90000)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-tab-sync-send-"))
  const Db = PouchDB.defaults({ prefix: directory + path.sep })
  const remote = new Db("once")
  await remote.info()
  const feed = await startPageServer()
  const urls = stories.storyUrls(feed.origin)
  const api = expressPouchDB(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const http = await new Promise((resolve) => { const server = api.listen(0, "127.0.0.1", () => resolve(server)) })
  const app = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0", ONCE_ELECTRON_TABSYNC_TIMING: QUICK_PUBLISHING } })
  try {
    const page = app.window
    await openSettingsSection(page, "sync", "#couch_input")
    await page.getByTestId("sync-url").fill(`http://127.0.0.1:${http.address().port}/once`)
    await page.getByTestId("save-sync").click()
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 20000 })
    await page.getByTestId("tab-sync-offer-see").click()
    const self = JSON.parse(await page.evaluate(() => window.onceElectron.settings.getSecret("once:device-identity"))).id
    const at = new Date().toISOString()
    await remote.bulkDocs([{
      _id: `dev_${otherDevice}`, type: "device", schema: 1, deviceId: otherDevice, epoch: 1, seq: 4, name: "Test phone",
      platform: "android", appVersion: "1", sharing: true, updatedAt: at,
      windows: [{ id: "phone", focused: true, tabs: [{ id: "a", navSeq: 1, url: urls.epsilon, title: "Epsilon watched on the phone",
        mode: "web", active: true, openedAt: at, navigatedAt: at, selectedAt: at, activityAt: at,
        state: { media: { v: 1, capturedAt: at, data: { currentTime: 33, duration: 60, paused: true, rate: 1 } } } }] }]
    }, {
      _id: `tsend_${self}_0123456789abcdef0123456789abcdef`, type: "send", from: otherDevice, fromName: "Test phone",
      url: urls.zeta, title: "Zeta sent from the phone", mode: "web", createdAt: at
    }])

    const toast = page.getByTestId("sent-tab-toast")
    await expect(toast).toContainText("Zeta sent from the phone", { timeout: 20000 })
    await expect(toast).toContainText("Sent from Test phone")
    await toast.getByRole("button", { name: "Open" }).click()
    await expect.poll(async () => (await page.evaluate(() => window.onceElectron.tabs.getAll())).find((tab) => tab.active)?.url).toBe(urls.zeta)
    await expect.poll(async () => (await remote.allDocs({ startkey: "tsend_", endkey: "tsend_￿" })).rows.length, { timeout: 20000 }).toBe(0)

    // Offering to continue is opt-in: nothing until it is turned on.
    const banner = page.getByTestId("continue-banner")
    await expect(banner).toHaveCount(0)
    await page.getByTestId("sync-page-tabs").click()
    await page.locator("#tab_sync_continue").check()
    await expect(banner).toContainText("Continue “Epsilon watched on the phone”")
    await expect(banner).toContainText("Test phone · Paused 0:33 / 1:00")
    await banner.screenshot({ path: "artifacts/tab-sync/continue-banner-electron.png" })
    await banner.getByRole("button", { name: "Close" }).click()
    await expect(banner).toBeHidden()
  } finally {
    await closeApp(app.electronApp, app.userData)
    await feed.close()
    http.closeAllConnections()
    await new Promise((resolve) => http.close(resolve))
    await remote.destroy()
  }
})
