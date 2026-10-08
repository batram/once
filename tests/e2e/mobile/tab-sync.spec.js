const { test, expect } = require("@playwright/test")
const { gotoMobileApp } = require("./helpers/mobile-app")
const { openSettingsSection } = require("./helpers/settings")

const auth = { Authorization: `Basic ${Buffer.from("once-test:once-test").toString("base64")}` }
const otherDevice = "fedcba9876543210fedcba9876543210"

test("the phone shares its reading tabs and lists other devices' tabs in the tab view", async ({ page, request, baseURL }) => {
  const database = "web_tab_sync"
  const server = new URL(baseURL).origin
  const at = new Date().toISOString()
  await request.post(`${server}/test/databases/${database}/reset`, {
    data: { docs: [{
      _id: `dev_${otherDevice}`, type: "device", schema: 1, deviceId: otherDevice, epoch: 1, seq: 2, name: "Test laptop",
      platform: "electron", appVersion: "1", sharing: true, updatedAt: at,
      windows: [{ id: "1", focused: true, tabs: [{ id: "a", navSeq: 1, url: `${server}/fixtures/article.html?from=laptop`,
        title: "Article on the laptop", mode: "web", active: true, openedAt: at, navigatedAt: at, selectedAt: at, activityAt: at }] }]
    }] }
  })
  await gotoMobileApp(page)
  await openSettingsSection(page, "sync")
  await page.getByTestId("sync-url").fill(`${server.replace("http://", "http://once-test:once-test@")}/db/${database}`)
  await page.getByTestId("save-sync").click()
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 15_000 })
  await page.getByTestId("tab-sync-offer-share").click()

  await page.getByRole("button", { name: "Reading", exact: true }).click()
  await page.locator("#reading_url").fill("https://first.example/")
  await page.locator("#reading_url").press("Enter")
  await expect.poll(async () => {
    const response = await request.get(`${server}/db/${database}/_all_docs?include_docs=true&startkey=%22dev_%22&endkey=%22dev_%EF%BF%BF%22`, { headers: auth })
    const rows = response.ok() ? (await response.json()).rows : []
    return rows.map((row) => row.doc).filter((doc) => doc.deviceId !== otherDevice)
      .flatMap((doc) => doc.windows.flatMap((window) => window.tabs.map((tab) => tab.url)))
  }, { timeout: 30_000 }).toEqual(["https://first.example/"])

  await page.locator("#reading_tabs").click()
  const others = page.getByTestId("reading-tabs-other-devices")
  await expect(others).toContainText("Test laptop")
  await page.getByRole("tab", { name: /^Other devices/ }).click()
  await page.locator("#reading_tabs_dialog").screenshot({ path: "artifacts/tab-sync/tab-view-mobile.png" })
  await others.getByText("Article on the laptop").click()
  await expect(page.locator("#reading_tabs_dialog")).toBeHidden()
  await expect(page.locator("#reading_url")).toHaveValue(`${server}/fixtures/article.html?from=laptop`)
  await expect(page.locator("#reading_tabs")).toHaveText("2")
})

test("an article opened from another device continues where it was read, and its own position is shared", async ({ page, request, baseURL }) => {
  const database = "web_tab_sync_reader"
  const server = new URL(baseURL).origin
  const at = new Date().toISOString()
  const article = `${server}/fixtures/article.html?from=laptop`
  await request.post(`${server}/test/databases/${database}/reset`, {
    data: { docs: [{
      _id: `dev_${otherDevice}`, type: "device", schema: 1, deviceId: otherDevice, epoch: 1, seq: 2, name: "Test laptop",
      platform: "electron", appVersion: "1", sharing: true, updatedAt: at,
      windows: [{ id: "1", focused: true, tabs: [{ id: "a", navSeq: 1, url: article, title: "Article read on the laptop", mode: "reader",
        active: true, openedAt: at, navigatedAt: at, selectedAt: at, activityAt: at,
        state: { "reader.scroll": { v: 1, capturedAt: at, data: { fraction: 0.6, anchor: null } } } }] }]
    }] }
  })
  await gotoMobileApp(page)
  await page.setViewportSize({ width: 390, height: 500 })
  await openSettingsSection(page, "sync")
  await page.getByTestId("sync-url").fill(`${server.replace("http://", "http://once-test:once-test@")}/db/${database}`)
  await page.getByTestId("save-sync").click()
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 15_000 })
  await page.getByTestId("tab-sync-offer-share").click()

  await page.getByRole("button", { name: "Reading", exact: true }).click()
  await page.locator("#reading_tabs").click()
  const others = page.getByTestId("reading-tabs-other-devices")
  await page.getByRole("tab", { name: /^Other devices/ }).click()
  await expect(others).toContainText("Read 60 %")
  await others.getByText("Article read on the laptop").click()
  await expect(page.locator("#reading_content")).toHaveAttribute("data-mode", "reader")
  const reader = page.locator(".once-reader-host-frame").last().contentFrame()
  await expect(reader.locator("article p").first()).toBeVisible()
  await expect.poll(() => reader.locator("html").evaluate(() => {
    const scroller = document.scrollingElement
    return Math.round(scroller.scrollTop / Math.max(1, scroller.scrollHeight - innerHeight) * 10) / 10
  }), { timeout: 10_000 }).toBe(0.6)

  await reader.locator("html").evaluate(() => { document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight })
  await expect.poll(async () => {
    const response = await request.get(`${server}/db/${database}/_all_docs?include_docs=true&startkey=%22dev_%22&endkey=%22dev_%EF%BF%BF%22`, { headers: auth })
    const rows = response.ok() ? (await response.json()).rows : []
    const tab = rows.map((row) => row.doc).filter((doc) => doc.deviceId !== otherDevice)
      .flatMap((doc) => doc.windows.flatMap((window) => window.tabs)).find((item) => item.url === article)
    return tab?.state?.["reader.scroll"]?.data.fraction ?? 0
  }, { timeout: 40_000 }).toBeGreaterThan(0.9)
})

test("a tab card's own menu in the tab view sends that tab to another device", async ({ page, request, baseURL }) => {
  const database = "web_tab_sync_send"
  const server = new URL(baseURL).origin
  const at = new Date().toISOString()
  await request.post(`${server}/test/databases/${database}/reset`, {
    data: { docs: [{ _id: `dev_${otherDevice}`, type: "device", schema: 1, deviceId: otherDevice, epoch: 1, seq: 2,
      name: "Test laptop", platform: "electron", appVersion: "1", sharing: false, updatedAt: at, windows: [] }] }
  })
  await gotoMobileApp(page)
  await openSettingsSection(page, "sync")
  await page.getByTestId("sync-url").fill(`${server.replace("http://", "http://once-test:once-test@")}/db/${database}`)
  await page.getByTestId("save-sync").click()
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 15_000 })
  await page.getByTestId("tab-sync-offer-see").click()

  await page.getByRole("button", { name: "Reading", exact: true }).click()
  await page.locator("#reading_url").fill("https://first.example/to-send")
  await page.locator("#reading_url").press("Enter")
  await page.locator("#reading_tabs").click()
  // The other device has arrived once the tab view lists it.
  await expect(page.getByTestId("reading-tabs-other-devices")).toContainText("Test laptop")
  // The card says what is sent: its own menu, from a long press (a right click here).
  await expect(page.getByTestId("reading-tabs-send")).toHaveCount(0)
  await page.locator('#reading_tabs_dialog button[data-action="select"]').first().click({ button: "right" })
  await page.getByTestId("menu-send").click()
  await page.getByTestId(`menu-${otherDevice}`).click()
  await expect(page.locator(".reading_tab_status")).toHaveText("Sent to Test laptop")
  const response = await request.get(`${server}/db/${database}/_all_docs?include_docs=true&startkey=%22tsend_${otherDevice}_%22&endkey=%22tsend_${otherDevice}_%EF%BF%BF%22`, { headers: auth })
  const sends = (await response.json()).rows.map((row) => row.doc)
  expect(sends.map((send) => send.url)).toEqual(["https://first.example/to-send"])
})

test("a tab sent to the phone is announced in its own band above the tab bar, never over it or off screen", async ({ page, request, baseURL }) => {
  const database = "web_tab_sync_notice"
  const server = new URL(baseURL).origin
  const at = new Date().toISOString()
  await request.post(`${server}/test/databases/${database}/reset`, {
    data: { docs: [{ _id: `dev_${otherDevice}`, type: "device", schema: 1, deviceId: otherDevice, epoch: 1, seq: 2,
      name: "Test laptop", platform: "electron", appVersion: "1", sharing: false, updatedAt: at, windows: [] }] }
  })
  await gotoMobileApp(page)
  await page.setViewportSize({ width: 375, height: 700 })
  await openSettingsSection(page, "sync")
  await page.getByTestId("sync-url").fill(`${server.replace("http://", "http://once-test:once-test@")}/db/${database}`)
  await page.getByTestId("save-sync").click()
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 15_000 })
  await page.getByTestId("tab-sync-offer-see").click()
  // The phone appears as a place to send to once its presence is published.
  let self
  await expect.poll(async () => {
    const response = await request.get(`${server}/db/${database}/_all_docs?startkey=%22dev_%22&endkey=%22dev_%EF%BF%BF%22`, { headers: auth })
    self = (response.ok() ? (await response.json()).rows : []).map((row) => row.id.slice(4)).find((id) => id !== otherDevice)
    return Boolean(self)
  }, { timeout: 30_000 }).toBe(true)
  await request.post(`${server}/db/${database}/_bulk_docs`, { headers: auth, data: { docs: [{
    _id: `tsend_${self}_0123456789abcdef0123456789abcdef`, type: "send", from: otherDevice, fromName: "Test laptop",
    url: "https://sent.example/a-page-with-a-rather-long-title", title: "A page sent from the laptop with a rather long title", mode: "web", createdAt: at
  }] } })
  await page.getByRole("button", { name: "Reading", exact: true }).click()
  const toast = page.getByTestId("sent-tab-toast")
  await expect(toast).toContainText("Sent from Test laptop", { timeout: 20_000 })
  const geometry = await page.evaluate(() => {
    const notice = document.querySelector("[data-testid=sent-tab-toast]").getBoundingClientRect()
    const menu = document.querySelector("#menu").getBoundingClientRect()
    const content = document.querySelector("#reading_content").getBoundingClientRect()
    return { left: notice.left, right: notice.right, bottom: notice.bottom, top: notice.top, menuTop: menu.top, contentBottom: content.bottom, width: innerWidth }
  })
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(geometry.width)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.menuTop + 1)
  // The reading view (where the native page is drawn) ends above the notice.
  expect(geometry.contentBottom).toBeLessThanOrEqual(geometry.top + 1)
  await page.screenshot({ path: "artifacts/tab-sync/sent-notice-mobile.png" })
  await toast.getByRole("button", { name: "Open" }).click()
  await expect(page.locator("#reading_url")).toHaveValue("https://sent.example/a-page-with-a-rather-long-title")
  await expect(toast).toBeHidden()
})

test("never-share domains take the row's full width on a wide phone and grow with their lines", async ({ page, request, baseURL }) => {
  const database = "web_tab_sync_excluded"
  const server = new URL(baseURL).origin
  await request.post(`${server}/test/databases/${database}/reset`, { data: { docs: [] } })
  await gotoMobileApp(page)
  // iPhone Pro Max width: wide enough for the two-column rows.
  await page.setViewportSize({ width: 440, height: 956 })
  await openSettingsSection(page, "sync")
  await page.getByTestId("sync-url").fill(`${server.replace("http://", "http://once-test:once-test@")}/db/${database}`)
  await page.getByTestId("save-sync").click()
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 15_000 })
  // Sync's state shows in the titlebar of Sync and its pages, nowhere else in Settings.
  const status = page.locator("#sync_status_button")
  await expect(status).toBeVisible()
  await expect(status).toHaveAttribute("title", "Up to date")
  await page.getByTestId("tab-sync-offer-share").click()
  await page.getByTestId("sync-page-tabs").click()
  await expect(status).toBeVisible()
  const field = page.getByTestId("tab-sync-excluded")
  const box = async () => field.evaluate((element) => {
    const own = element.getBoundingClientRect()
    const row = element.closest(".settings_row").getBoundingClientRect()
    const name = element.closest(".settings_row").querySelector(".settings_row_name").getBoundingClientRect()
    return { width: own.width, rowWidth: row.width, height: own.height, top: own.top, nameBottom: name.bottom }
  })
  const before = await box()
  expect(before.width).toBeGreaterThan(before.rowWidth - 2)
  expect(before.top).toBeGreaterThanOrEqual(before.nameBottom)
  await field.fill(["a.example", "b.example", "c.example", "d.example", "e.example", "f.example"].join("\n"))
  const after = await box()
  expect(after.height).toBeGreaterThan(before.height)
  expect(await field.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1)
  await page.locator("#sync_page_tabs").screenshot({ path: "artifacts/tab-sync/never-share-wide-phone.png" })
  await openSettingsSection(page, "theme")
  await expect(status).toBeHidden()
})
