const { test, expect } = require("./electron-harness")
const { closeApp, launchApp, startPageServer } = require("./electron-harness")

test("extensions panel supports direct actions, persistent pins, and settings @interactive", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp({ background: false })
  try {
    await window.evaluate(url => window.onceElectron.tabs.create(url, true), server.origin)
    const toolbar = window.locator("#extension_actions")
    const trigger = toolbar.getByRole("button", { name: "Extensions", exact: true })
    await expect.poll(() => window.evaluate(async () => (await window.onceElectron.extensions.list()).length)).toBe(2)
    // The panel is found by what it shows, not by which page Playwright reports
    // next: its window event also fires for tab contents, and an extension page
    // opened moments earlier can be the one it reports. The panel window exists
    // before its menu page has loaded, so its URL is polled on the navigation
    // budget rather than read once.
    const openPanel = async () => {
      const isPanel = page => page !== window && /extension_menu/.test(page.url())
      await trigger.click()
      await expect.poll(() => electronApp.windows().some(isPanel), { timeout: 20_000 }).toBe(true)
      const panel = electronApp.windows().find(isPanel)
      await panel.waitForLoadState("domcontentloaded")
      await expect(panel.getByRole("heading", { name: "Extensions" })).toBeVisible()
      return panel
    }
    let panel = await openPanel()
    const info = await window.evaluate(async () => (await window.onceElectron.extensions.list())[0])
    await panel.getByRole("button", { name: `Pin ${info.name}`, exact: true }).click()
    await expect(toolbar.locator(".extension-action")).toHaveCount(1)
    await expect(panel.getByRole("button", { name: `Unpin ${info.name}`, exact: true })).toHaveAttribute("aria-pressed", "true")
    expect(await panel.locator("#extensions").evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true)
    await panel.screenshot({ path: "artifacts/extension-toolbar-panel.png" })
    await panel.getByRole("button", { name: "Manage extensions", exact: true }).click()
    await expect(window.locator("#left_panel")).toHaveAttribute("active_panel", "settings")
    await expect(window.locator('.settings_section[data-settings-section="extensions"]')).toHaveClass(/active/)
    await expect(trigger).toHaveAttribute("aria-expanded", "false")
    // Taken once the panel is gone: capturing the main window can take focus,
    // and the panel closes on blur.
    await toolbar.screenshot({ path: "artifacts/extension-toolbar-icons.png" })

    panel = await openPanel()
    await expect(panel.getByRole("button", { name: `Unpin ${info.name}`, exact: true })).toBeVisible()
    await panel.getByRole("button", { name: `Open ${info.name}`, exact: true }).click()
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }, host) => BrowserWindow.getAllWindows()
      .some(owner => owner.contentView.children.some(view => view.webContents?.getURL().startsWith(`moz-extension://${host}/`))), info.host)).toBe(true)
    await window.evaluate(() => window.onceElectron.window.focusShell())

    panel = await openPanel()
    await panel.getByRole("button", { name: `Unpin ${info.name}`, exact: true }).click()
    await expect(toolbar.locator(".extension-action")).toHaveCount(0)
    const dismissed = panel.waitForEvent("close")
    // Escape disposes the native window before Playwright can send key-up.
    await panel.keyboard.press("Escape").catch(error => { if (!panel.isClosed()) throw error })
    await dismissed
    await expect(trigger).toHaveAttribute("aria-expanded", "false")
    await expect(trigger).toBeFocused()
    expect(await window.evaluate(() => JSON.parse(localStorage.getItem("once-electron-pinned-extensions")))).toEqual([])

    panel = await openPanel()
    await window.evaluate(() => window.onceElectron.window.focusShell())
    await expect.poll(() => panel.isClosed()).toBe(true)
    await expect(trigger).toHaveAttribute("aria-expanded", "false")

    panel = await openPanel()
    await panel.getByRole("button", { name: `Pin ${info.name}`, exact: true }).click()
    await panel.getByRole("button", { name: "Close extensions", exact: true }).click()
    await expect(trigger).toHaveAttribute("aria-expanded", "false")
    await window.reload()
    await expect(window.locator("body")).toHaveAttribute("data-once-ready", "true")
    await expect(toolbar.locator(".extension-action")).toHaveCount(1)
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})
