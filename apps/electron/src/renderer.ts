import { createOnceApp } from "@once/app"
import { FilterListsDocument, UserscriptsDocument } from "@once/core"
import { createElectronPlatform } from "@once/platform-electron"
import { ElectronRedirectRule } from "@once/platform-electron/bridge"
import {
  bindMenuCollapseControls,
  HoverUrlIndicator,
  mountOnceUi,
  ReaderView,
  SourcePickerView,
  describeStoryMenu,
  executeStoryMenuAction,
  storyFromTarget,
  StoryMenuActionId
} from "@once/ui-web"
import { BrowserShell } from "./BrowserShell"
import "./electron.css"

document.addEventListener("DOMContentLoaded", async () => {
  const buildInfo = await window.onceElectron.app.getBuildInfo()
  document.body.classList.add(`electron-platform-${buildInfo.platform}`)

  const platform = createElectronPlatform(window.onceElectron)
  const app = createOnceApp(platform)
  ReaderView.mount(
    app.client,
    (html, sourceUrl, target) =>
      window.onceElectron.tabs.openReader(html, sourceUrl, target)
  )
  // Reader requests raised by the browser shell carry their own delivery
  // callback, which is what lets the shell keep them tied to one tab.
  const runReaderRequest = (
    url: string,
    deliver: (html: string, sourceUrl: string) => Promise<void>
  ): Promise<void> =>
    ReaderView.openWith(url, "_self", (html, sourceUrl) => deliver(html, sourceUrl))
  SourcePickerView.mount(app.client, (url) =>
    window.onceElectron.tabs.startSourcePicker(url)
  )
  const browserShell = new BrowserShell(window.onceElectron, runReaderRequest)
  const onMenuCollapsedChanged = (collapsed: boolean): void =>
    browserShell.setLeftCollapsed(collapsed)
  bindMenuCollapseControls(onMenuCollapsedChanged)

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
  // The startup publish happened before this subscription existed, so the
  // first hand-off reads the documents directly.
  const applyExtensionSettings = async (
    settings?: { filterLists: FilterListsDocument; userscripts: UserscriptsDocument }
  ): Promise<void> => {
    try {
      await window.onceElectron.extensions.applySettings(settings ?? {
        filterLists: await app.client.getFilterLists(),
        userscripts: await app.client.getUserscripts()
      })
    } catch (error) {
      console.error("Failed to hand settings to the extensions", error)
    }
  }
  void applyExtensionSettings()
  app.client.subscribe("extensionSettingsChanged", (settings) => {
    void applyExtensionSettings(settings)
  })
  await mountOnceUi(app.client, {
    shell: "electron",
    appVersion: buildInfo.version,
    buildChannel: buildInfo.channel,
    buildIdentifier: buildInfo.buildIdentifier,
    updater: {
      getStatus: () => window.onceElectron.app.getUpdateStatus(),
      checkForUpdates: () => window.onceElectron.app.checkForUpdates(),
      onStatusChanged: (handler) =>
        window.onceElectron.app.onUpdateStatusChanged(handler)
    },
    showHoveredLinks: true,
    initialStoryLoad: new URL(window.location.href).searchParams.has(
      "disableStoryLoading"
    )
      ? "disabled"
      : "cache",
    onMenuCollapsedChanged,
    // The renderer owns the keybinding config; main only mirrors the chords it
    // must steal from focused pages.
    onKeyBindingsChanged: (chords) => {
      void window.onceElectron.window.setForwardedKeys(chords)
    }
  })
  document.addEventListener("contextmenu", (event) => {
    const story = storyFromTarget(event.target)
    const onStoryList = Boolean(
      story || (event.target as Element | null)?.closest(".stories_container")
    )
    if (!onStoryList) return
    event.preventDefault()
    const items = describeStoryMenu({
      platform: "electron",
      buildChannel: buildInfo.channel,
      story
    })
    void window.onceElectron.storyMenu
      .show(items, { x: event.clientX, y: event.clientY })
      .then(async (selected) => {
        if (!selected) return
        const action = selected as StoryMenuActionId
        const url = story?.dataset.redirected_url || story?.story.href
        if (action === "open-new-window" && url && story) {
          await app.client.persistStoryChange(story.story.href, "read_state", "read")
          await window.onceElectron.storyMenu.openWindow(url)
          return
        }
        if (action === "open-external" && url && story) {
          await app.client.persistStoryChange(story.story.href, "read_state", "read")
          await window.onceElectron.storyMenu.openExternal(url)
          return
        }
        await executeStoryMenuAction(action, story)
      })
  }, true)
  window.onceElectron.window.onTargetUrlChanged((url) => {
    HoverUrlIndicator.show(url)
  })
  document.body.dataset.onceReady = "true"
})
