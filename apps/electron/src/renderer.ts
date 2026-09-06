import { createOnceApp, OnceClient } from "@once/app"
import { FilterListsDocument, UserscriptsDocument } from "@once/core"
import { createElectronPlatform } from "@once/platform-electron"
import { ElectronRedirectRule, ElectronUpdateStatus } from "@once/platform-electron/bridge"
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
import { bindBrowserExtensionSettings } from "./BrowserExtensionSettings"
import { bindAccessibilitySetting } from "./AccessibilitySetting"
import "./electron.css"
import "./browserExtensionSettings.css"

// Served by main from the Forge output: a sandboxed frame has an opaque origin
// and may not load file: subresources, so the add-on sandbox page needs a scheme.
const ADDON_SANDBOX_URL = "once-addon://sandbox/index.html"

// Main reads ONCE_ADDONS directories (unpackaged builds only) and tells the
// renderer when a file in one changes.
const DEV_ADDONS = {
  pickDirectory: () => window.onceElectron.addons.pickDirectory(),
  removeDirectory: (directory: string) => window.onceElectron.addons.removeDirectory(directory),
  list: () => window.onceElectron.addons.devEntries(),
  onChanged: (listener: () => void) => window.onceElectron.addons.onDevChanged(listener)
}

const UPDATER = {
  getStatus: () => window.onceElectron.app.getUpdateStatus(),
  checkForUpdates: () => window.onceElectron.app.checkForUpdates(),
  onStatusChanged: (handler: (status: ElectronUpdateStatus) => void) =>
    window.onceElectron.app.onUpdateStatusChanged(handler)
}

/**
 * The two directions of the extension settings exchange. Once hands its synced
 * documents to the extensions that act on them, and takes back whatever their
 * own dashboards changed — a userscript edited, toggled, added or removed in
 * Violentmonkey — so that edit survives the next hand-off and reaches this
 * account's other devices. Saving publishes another change, which hands the
 * same document straight back and finds nothing left to reconcile.
 */
function exchangeExtensionSettings(client: OnceClient): void {
  const apply = async (
    settings?: { filterLists: FilterListsDocument; userscripts: UserscriptsDocument }
  ): Promise<void> => {
    try {
      await window.onceElectron.extensions.applySettings(settings ?? {
        filterLists: await client.getFilterLists(),
        userscripts: await client.getUserscripts()
      })
    } catch (error) {
      console.error("Failed to hand settings to the extensions", error)
    }
  }
  // The startup publish happened before this subscription existed, so the
  // first hand-off reads the documents directly.
  void apply()
  client.subscribe("extensionSettingsChanged", (settings) => void apply(settings))
  window.onceElectron.extensions.onSettingsAdopted((adopted) => {
    if (!adopted.userscripts) return
    void client.saveUserscripts(adopted.userscripts).catch((error) => {
      console.error("Failed to save a userscript change made in the dashboard", error)
    })
  })
}

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
  bindAccessibilitySetting(window.onceElectron)
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
  exchangeExtensionSettings(app.client)
  await mountOnceUi(app.client, {
    shell: "electron",
    addonSandboxUrl: ADDON_SANDBOX_URL,
    devAddons: DEV_ADDONS,
    appVersion: buildInfo.version,
    buildChannel: buildInfo.channel,
    buildIdentifier: buildInfo.buildIdentifier,
    updater: UPDATER,
    // The bundled uBlock Origin and Violentmonkey take both documents above.
    extensionSettings: true,
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
  bindBrowserExtensionSettings(app.client, window.onceElectron)
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
