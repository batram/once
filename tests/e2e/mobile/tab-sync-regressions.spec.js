const { test, expect } = require("@playwright/test")
const { gotoMobileApp } = require("./helpers/mobile-app")
const { openSettingsSection } = require("./helpers/settings")
const { edgeSwipe } = require("./helpers/gestures")
const { encodePairingLink } = require("../../../packages/core/dist")
const auth = { Authorization: `Basic ${Buffer.from("once-test:once-test").toString("base64")}` }
const other = "fedcba9876543210fedcba9876543210"

async function connect(page, request, baseURL, database) {
  const server = new URL(baseURL).origin
  await request.post(`${server}/test/databases/${database}/reset`, { data: { docs: [] } })
  await gotoMobileApp(page)
  await openSettingsSection(page, "sync")
  const url = `${server.replace("http://", "http://once-test:once-test@")}/db/${database}`
  await page.getByTestId("sync-url").fill(url)
  await page.getByTestId("save-sync").click()
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date")
  await page.getByTestId("tab-sync-offer-share").click()
  return { db: `${server}/db/${database}`, url }
}

function device() {
  const at = new Date().toISOString()
  return { _id: `dev_${other}`, type: "device", schema: 1, deviceId: other, epoch: 1, seq: 1,
    name: "Review laptop", platform: "electron", appVersion: "1", sharing: true, sendTarget: true, updatedAt: at,
    windows: [{ id: "w", focused: true, tabs: [{ id: "a", navSeq: 1, url: "https://example.com/a", title: "Article one", mode: "web",
      active: true, openedAt: at, navigatedAt: at, selectedAt: at, activityAt: at }] }] }
}

test("receiving off stays quiet and re-enabling exposes the queued tab", async ({ page, request, baseURL }) => {
  const { db } = await connect(page, request, baseURL, "receiving_regression")
  await page.getByTestId("sync-page-tabs").click()
  await page.getByRole("checkbox", { name: "Receive sent tabs", exact: true }).uncheck()
  let self
  await expect.poll(async () => {
    const rows = (await (await request.get(`${db}/_all_docs?include_docs=true`, { headers: auth })).json()).rows
    self = rows.map(row => row.doc).find(doc => doc.type === "device")
    return self?.sendTarget
  }).toBe(false)
  await request.post(`${db}/_bulk_docs`, { headers: auth, data: { docs: [{ _id: `tsend_${self.deviceId}_0123456789abcdef0123456789abcdef`,
    type: "send", from: other, fromName: "Review laptop", url: "https://example.com/queued", title: "Queued while receiving is off",
    mode: "web", createdAt: new Date().toISOString() }] } })
  await expect(page.getByTestId("sent-tab-toast")).toHaveCount(0)
  await page.getByRole("checkbox", { name: "Receive sent tabs", exact: true }).check()
  await expect(page.getByTestId("sent-tab-toast")).toContainText("Queued while receiving is off")
})

test("remote updates retain keyboard focus and phone navigation jumps directly to other devices", async ({ page, request, baseURL }) => {
  const { db } = await connect(page, request, baseURL, "focus_regression")
  await request.post(`${db}/_bulk_docs`, { headers: auth, data: { docs: [device()] } })
  await page.getByRole("button", { name: "Reading", exact: true }).click()
  await page.locator("#reading_tabs").click()
  await expect(page.locator("#reading_tabs_dialog .remote_device_toggle")).toContainText("Review laptop")
  await page.getByRole("tablist", { name: "Tab groups" }).getByRole("tab", { name: /^Other devices/ }).click()
  await expect(page.getByRole("tab", { name: /^Other devices/ })).toHaveAttribute("aria-selected", "true")
  // The filter waits behind its search button on a phone.
  await expect(page.getByRole("searchbox", { name: "Filter tabs from other devices" })).toBeHidden()
  await page.getByRole("button", { name: "Filter tabs", exact: true }).click()
  await expect(page.getByRole("searchbox", { name: "Filter tabs from other devices" })).toBeFocused()
  const header = page.locator("#reading_tabs_dialog .remote_device_toggle")
  await expect(header).toContainText("Review laptop")
  await header.focus()
  const current = await (await request.get(`${db}/dev_${other}`, { headers: auth })).json()
  await request.put(`${db}/dev_${other}`, { headers: auth, data: { ...current, seq: 2, name: "Updated laptop" } })
  await expect(header).toContainText("Updated laptop")
  await expect(header).toBeFocused()
  const link = page.getByRole("link", { name: /Article one/ })
  await link.focus()
  const next = await (await request.get(`${db}/dev_${other}`, { headers: auth })).json()
  await request.put(`${db}/dev_${other}`, { headers: auth, data: { ...next, seq: 3, name: "Final laptop" } })
  await expect(header).toContainText("Final laptop")
  await expect(link).toBeFocused()
})

test("back from tab sync settings opened in the tab view returns to its other devices", async ({ page, request, baseURL }) => {
  const { db } = await connect(page, request, baseURL, "settings_return_regression")
  await request.post(`${db}/_bulk_docs`, { headers: auth, data: { docs: [device()] } })
  await page.getByRole("button", { name: "Reading", exact: true }).click()
  await page.locator("#reading_tabs").click()
  await page.getByRole("tablist", { name: "Tab groups" }).getByRole("tab", { name: /^Other devices/ }).click()
  await page.locator("#reading_tabs_dialog").getByTestId("remote-tabs-settings").click()
  await expect(page.locator("#left_panel")).toHaveAttribute("active_panel", "settings")
  await expect(page.getByRole("checkbox", { name: "Receive sent tabs", exact: true })).toBeVisible()
  await edgeSwipe(page, "back")
  await expect(page.locator("#left_panel")).toHaveAttribute("active_panel", "reading")
  await expect(page.locator("#reading_tabs_dialog")).toHaveAttribute("open", "")
  await expect(page.getByRole("tab", { name: /^Other devices/ })).toHaveAttribute("aria-selected", "true")
  await expect(page.locator("#reading_tabs_dialog .remote_device_toggle")).toContainText("Review laptop")
})

test("pairing never claims success for invalid credentials and keeps one offer", async ({ page, request, baseURL }) => {
  test.setTimeout(90_000)
  const { url } = await connect(page, request, baseURL, "pairing_failure_regression")
  await page.getByTestId("sync-page-pair").click()
  const link = encodePairingLink({ syncUrl: url.replace("once-test:once-test@", "once-test:wrong-password@") })
  await page.locator("#pair_link_input").fill(link)
  await page.locator("#pair_connect").click()
  await page.getByTestId("pair-confirm").getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.locator("#pair_status")).not.toHaveText("Connected")
  await expect(page.getByTestId("pair-make")).toHaveCount(1)
  await expect(page.locator("#pair_status")).toContainText(/Could not connect|unable to confirm/, { timeout: 70_000 })
  await expect(page.locator("#pair_link_input")).toHaveValue(link)
  await expect(page.getByTestId("pair-make")).toHaveCount(1)
})

test("storage cleanup and inactive-device removal are explicit and show their results", async ({ page, request, baseURL }) => {
  const { db } = await connect(page, request, baseURL, "storage_regression")
  const inactive = { ...device(), updatedAt: new Date(Date.now() - 40 * 86400_000).toISOString() }
  await request.post(`${db}/_bulk_docs`, { headers: auth, data: { docs: [inactive] } })
  await page.getByTestId("sync-page-tabs").click()
  await expect(page.getByTestId("tab-sync-device")).toContainText("Review laptop")
  await page.getByText("Storage and cleanup", { exact: true }).click()
  await page.getByRole("button", { name: "Clean up now", exact: true }).click()
  await expect(page.locator("#tab_sync_storage_status")).toContainText("Last completed cleanup:")
  await page.getByRole("button", { name: "Remove inactive devices…", exact: true }).click()
  await page.getByRole("button", { name: "Remove inactive devices", exact: true }).click()
  await expect(page.getByTestId("tab-sync-device")).toHaveCount(0)
  await expect(page.locator("#tab_sync_storage_status")).toContainText("1 removal record")
})
