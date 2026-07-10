import { createOnceApp } from "@once/app"
import { createElectronPlatform } from "@once/platform-electron"
import { ElectronRedirectRule } from "@once/platform-electron/bridge"
import { mountOnceUi, ReaderView } from "@once/ui-web"
import { BrowserShell } from "./BrowserShell"
import "./electron.css"

document.addEventListener("DOMContentLoaded", async () => {
  const platform = createElectronPlatform(window.onceElectron)
  const app = createOnceApp(platform)
  ReaderView.mount(
    app.client,
    (html, sourceUrl, target) =>
      window.onceElectron.tabs.openReader(html, sourceUrl, target)
  )
  const browserShell = new BrowserShell(
    window.onceElectron,
    (url) => ReaderView.open(url)
  )

  await app.start()
  const updateRedirects = async (
    redirects?: ElectronRedirectRule[]
  ): Promise<void> => {
    try {
      await window.onceElectron.window.setRedirects(
        redirects || (await app.client.getRedirectList())
      )
    } catch (error) {
      console.error("Failed to update Electron browser redirects", error)
    }
  }
  await updateRedirects()
  app.client.subscribe("redirectsChanged", ({ redirects }) => {
    void updateRedirects(redirects)
  })
  await mountOnceUi(app.client, {
    showHoveredLinks: true,
    onMenuCollapsedChanged: (collapsed) =>
      browserShell.setLeftCollapsed(collapsed)
  })
})
