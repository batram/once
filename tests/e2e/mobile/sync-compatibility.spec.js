const { test, expect } = require("@playwright/test")
const { gotoMobileApp } = require("./helpers/mobile-app")
const { openSettingsSection } = require("./helpers/settings")
const auth = { Authorization: `Basic ${Buffer.from("once-test:once-test").toString("base64")}` }

for (const width of [390, 1280]) for (const theme of ["light", "dark"]) {
  test(`update-required sync status ${width} ${theme}`, async ({ page, request, baseURL, context }) => {
    await page.setViewportSize({ width, height: 900 })
    const server = new URL(baseURL).origin, db = `compat_${width}_${theme}`
    await request.post(`${server}/test/databases/${db}/reset`, { data: { docs: [{ _id: "once_sync_compat", schema: 1, minSyncProtocol: 99, minAppVersion: "9.0.0" }] } })
    await gotoMobileApp(page)
    await openSettingsSection(page, "theme")
    await page.locator("#theme_select").selectOption(theme)
    await openSettingsSection(page, "sync")
    await page.getByTestId("sync-url").fill(`${server.replace("http://", "http://once-test:once-test@")}/db/${db}`)
    await page.getByTestId("save-sync").click()
    const warning = page.getByTestId("sync-compatibility")
    await expect(warning).toBeVisible()
    await expect(warning).toContainText("Update this app to resume")
    await expect(warning).toContainText("Minimum release: 9.0.0")
    await expect(warning).toContainText("Installed:")
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "update-required")
    await warning.getByRole("button", { name: "Check again" }).press("Enter")
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "update-required")
    const geometry = await warning.evaluate(node => ({ width: node.getBoundingClientRect().width, overflow: node.scrollWidth > node.clientWidth }))
    expect(geometry.overflow).toBe(false)
    expect(geometry.width).toBeLessThanOrEqual(width)
    const rows = await (await request.get(`${server}/db/${db}/_all_docs`, { headers: auth })).json()
    expect(rows.rows.filter(row => !row.id.startsWith("_design/")).map(row => row.id)).toEqual(["once_sync_compat"])
    await page.screenshot({ path: `test-results/sync-update-required-${width}-${theme}.png`, fullPage: true })
    if (width === 390 && theme === "dark") {
      await context.route("https://github.com/batram/once/releases/latest", route => route.fulfill({ body: "Mock release destination" }))
      const popup = page.waitForEvent("popup")
      await warning.getByRole("button", { name: "Update Once", exact: true }).click()
      const release = await popup
      await expect(release).toHaveURL("https://github.com/batram/once/releases/latest")
      await release.close()
    }
  })
}

test("damaged metadata remains distinguishable from an update requirement", async ({ page, request, baseURL }) => {
  const server = new URL(baseURL).origin, db = "compat_damaged"
  await request.post(`${server}/test/databases/${db}/reset`, { data: { docs: [{ _id: "once_sync_compat", schema: 42, minSyncProtocol: 2 }] } })
  await gotoMobileApp(page)
  await openSettingsSection(page, "sync")
  await page.getByTestId("sync-url").fill(`${server.replace("http://", "http://once-test:once-test@")}/db/${db}`)
  await page.getByTestId("save-sync").click()
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "error")
  await expect(page.getByTestId("sync-compatibility")).toContainText("database sync metadata needs attention")
  await expect(page.getByTestId("sync-compatibility").getByRole("button", { name: "Update Once" })).toBeHidden()
})
