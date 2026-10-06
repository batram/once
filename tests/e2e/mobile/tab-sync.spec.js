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
  await page.getByTestId("tab-sync-share").check()

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
  await others.scrollIntoViewIfNeeded()
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
  await page.getByTestId("tab-sync-share").check()

  await page.getByRole("button", { name: "Reading", exact: true }).click()
  await page.locator("#reading_tabs").click()
  const others = page.getByTestId("reading-tabs-other-devices")
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
