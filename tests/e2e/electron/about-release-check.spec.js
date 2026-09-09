const { test, expect } = require("@playwright/test")
const { launchApp, closeApp, openSettingsSection } = require("./electron-harness")

test("unmanaged About page checks a release and opens its page without installing", async () => {
  const { electronApp, userData, window } = await launchApp({
    env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" }
  })
  try {
    // Exercise the real main-process request and IPC with a deterministic
    // release response. No GitHub traffic or release downloads in this test.
    await electronApp.evaluate(({ session, net }) => {
      session.defaultSession.protocol.handle("https", request => {
        if (request.url === "https://api.github.com/repos/batram/once/releases/latest") {
          return new Response(JSON.stringify({ tag_name: "v9.8.7", draft: false, prerelease: false }), {
            headers: { "content-type": "application/json" }
          })
        }
        if (request.url.startsWith("https://github.com/batram/once/releases/")) {
          return new Response("<title>Fixture release</title><h1>Release v9.8.7</h1>", {
            headers: { "content-type": "text/html" }
          })
        }
        return net.fetch(request, { bypassCustomProtocolHandlers: true })
      })
    })
    await openSettingsSection(window, "about")
    const check = window.getByTestId("check-for-updates")
    const link = window.getByTestId("release-page")
    await expect(check).toBeEnabled()
    await expect(check).toHaveText("Check latest release")
    await expect(link).toHaveAttribute("href", "https://github.com/batram/once/releases/latest")
    await check.click()
    await expect(window.getByTestId("update-status")).toContainText("Latest release: v9.8.7.")
    await expect(check).toBeEnabled()
    await expect(link).toHaveAttribute("href", "https://github.com/batram/once/releases/tag/v9.8.7")
    await link.click()
    await expect.poll(() => window.evaluate(async () => (await window.onceElectron.tabs.getAll())
      .some(tab => tab.url === "https://github.com/batram/once/releases/tag/v9.8.7"))).toBe(true)
  } finally {
    await closeApp(electronApp, userData)
  }
})
