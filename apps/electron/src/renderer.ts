import { createOnceApp } from "@once/app"
import { createElectronPlatform } from "@once/platform-electron"
import { ElectronRedirectRule } from "@once/platform-electron/bridge"
import {
  HoverUrlIndicator,
  mountOnceUi,
  ReaderView,
  SourcePickerView
} from "@once/ui-web"
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
  SourcePickerView.mount(app.client, () =>
    window.onceElectron.tabs.startSourcePicker()
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
  const buildInfo = await window.onceElectron.app.getBuildInfo()
  await mountOnceUi(app.client, {
    appVersion: buildInfo.version,
    buildChannel: buildInfo.channel,
    showHoveredLinks: true,
    initialStoryLoad: new URL(window.location.href).searchParams.has(
      "disableStoryLoading"
    )
      ? "disabled"
      : "network",
    onMenuCollapsedChanged: (collapsed) =>
      browserShell.setLeftCollapsed(collapsed)
  })
  window.onceElectron.window.onTargetUrlChanged((url) => {
    HoverUrlIndicator.show(url)
  })
  document.body.dataset.onceReady = "true"
})
