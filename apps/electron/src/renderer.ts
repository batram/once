import { createOnceApp } from "@once/app"
import { createElectronPlatform } from "@once/platform-electron"
import { mountOnceUi } from "@once/ui-web"
import { BrowserShell } from "./BrowserShell"
import "./electron.css"

document.addEventListener("DOMContentLoaded", async () => {
  const browserShell = new BrowserShell(window.onceElectron)
  const platform = createElectronPlatform(window.onceElectron)
  const app = createOnceApp(platform)

  await app.start()
  await mountOnceUi(app.client, {
    showHoveredLinks: true,
    onMenuCollapsedChanged: (collapsed) =>
      browserShell.setLeftCollapsed(collapsed)
  })
})
