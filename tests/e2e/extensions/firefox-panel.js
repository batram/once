const { By } = require("selenium-webdriver")
const firefox = require("selenium-webdriver/firefox")

// Open the extension's sidepanel page as a normal, drivable tab.
//
// The panel ships as a `sidebar_action`, but its real sidebar surface is not
// automatable: Firefox's revamped sidebar hosts the panel in a nested browsing
// context that WebDriver/BiDi cannot address as a first-class target. Firefox
// 153 also blocks WebDriver-initiated navigation to `moz-extension://` URLs
// ("not allowed in this context") — both the classic `driver.get()` and a BiDi
// `browsingContext.navigate` (which silently lands on about:blank).
//
// So we let the *browser itself* open the page: from the privileged chrome
// context we add a tab with the system principal, which Firefox permits, and
// then drive that ordinary content tab with normal WebDriver. This requires
// enabling system access via `systemAccessService()`. See docs/DEVELOPMENT.md.
const OPEN_TAB = `const url = arguments[0]
  const win = Services.wm.getMostRecentWindow("navigator:browser") || window
  // The sidebar auto-opens the panel on install; hide it so only our driven
  // tab shows the panel (avoids the panel appearing twice).
  try { win.SidebarController && win.SidebarController.hide() } catch (e) {}
  const tab = win.gBrowser.addTab(url, {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
  })
  win.gBrowser.selectedTab = tab`

async function waitForPanelReady(driver) {
  await driver.wait(
    async () =>
      (await driver.findElement(By.css("body")).getAttribute("data-once-ready")) === "true",
    15_000,
    "extension panel did not become ready"
  )
}

async function openExtensionPanel(driver, extensionUuid) {
  const url = `moz-extension://${extensionUuid}/static/sidepanel.html?once-e2e=1`
  const before = await driver.getAllWindowHandles()
  await driver.setContext(firefox.Context.CHROME)
  try {
    await driver.executeScript(OPEN_TAB, url)
  } finally {
    await driver.setContext(firefox.Context.CONTENT)
  }
  const handle = await driver.wait(async () => {
    const handles = await driver.getAllWindowHandles()
    return handles.find((h) => !before.includes(h)) || false
  }, 10_000, "extension panel tab did not open")
  await driver.switchTo().window(handle)
  await waitForPanelReady(driver)
  return handle
}

// Reload the panel by closing its tab and opening a fresh one. Extension storage
// survives, so this exercises persistence across a reload without relying on
// WebDriver refresh, which FF153 rejects for moz-extension:// pages.
async function reopenExtensionPanel(driver, extensionUuid) {
  await driver.close()
  const remaining = await driver.getAllWindowHandles()
  await driver.switchTo().window(remaining[0])
  return openExtensionPanel(driver, extensionUuid)
}

// Build the geckodriver service that lets `openExtensionPanel` run privileged
// (system-principal) script in the chrome context.
//
// The privilege must be granted to the *geckodriver process*, not to Firefox via
// capabilities: geckodriver 0.36+ owns the `--allow-system-access` flag and
// rejects the Firefox arg `-remote-allow-system-access` when it is passed through
// `moz:firefoxOptions.args` ("Argument --remote-allow-system-access can't be set
// via capabilities"). The old capabilities form only appeared to work where an
// older geckodriver (<0.36) was on PATH; the pinned 0.37.x used on macOS/Linux CI
// rejects it. Passing it to the service works on every platform.
function systemAccessService() {
  return new firefox.ServiceBuilder().addArguments("--allow-system-access")
}

module.exports = {
  openExtensionPanel,
  reopenExtensionPanel,
  systemAccessService
}
