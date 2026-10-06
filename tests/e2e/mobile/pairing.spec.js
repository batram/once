const { test, expect } = require("@playwright/test")
const { gotoMobileApp } = require("./helpers/mobile-app")
const { openSettingsSection } = require("./helpers/settings")

test("a pasted pairing link connects the phone after naming the database", async ({ page, request, baseURL }) => {
  const database = "web_pairing"
  const server = new URL(baseURL).origin
  await request.post(`${server}/test/databases/${database}/reset`, { data: { docs: [{ _id: "theme", list: "light" }] } })
  const syncUrl = `${server.replace("http://", "http://once-test:once-test@")}/db/${database}`
  const link = `once://pair?v=1&u=${Buffer.from(syncUrl).toString("base64url")}`
  await gotoMobileApp(page)
  await openSettingsSection(page, "sync")
  await page.getByTestId("sync-page-pair").click()
  // The browser build has no camera to scan with.
  await expect(page.getByTestId("pair-scan")).toBeHidden()
  await page.getByTestId("pair-link").fill("https://not-a-pairing-link.example/")
  await page.getByTestId("pair-connect").click()
  await expect(page.getByTestId("pair-status")).toHaveText("This is not a Once pairing link")
  await page.getByTestId("pair-link").fill(link)
  await page.getByTestId("pair-connect").click()
  const confirm = page.getByTestId("pair-confirm")
  await expect(confirm).toContainText(`Connect to ${new URL(server).host}/db/${database} as once-test?`)
  await confirm.getByRole("button", { name: "Connect" }).click()
  await expect(page.locator("body")).toHaveAttribute("data-theme", "light", { timeout: 15_000 })
  await expect(page.getByTestId("pair-status")).toHaveText("Connected")
})
