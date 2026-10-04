import { installStoryNavigationBackground } from "@once/webext-shell/dist/storyNavigationBackground"
import browser from "webextension-polyfill"
import { installReaderBackground } from "@once/webext-shell/dist/readerBackground"
import { installPickerBackground } from "@once/webext-shell/dist/pickerBackground"
import { installStoryMenuBackground } from "@once/webext-shell/dist/storyMenuBackground"
import { installPageActionMenuBackground } from "@once/webext-shell/dist/pageActionMenuBackground"
import { installKeyCommandBackground } from "@once/webext-shell/dist/keyCommandBackground"
import { installConnectionOriginBackground, RequestRulesApi } from "@once/webext-shell/dist/connectionOriginBackground"
import { bundledPageActions } from "@once/ui-web/addons/bundledPageActions"
import type { BundledAddonFiles } from "@once/ui-web"

declare const __ONCE_BUNDLED_ADDONS__: BundledAddonFiles[]

// Chrome-only API, not covered by the Firefox-flavored polyfill types.
declare const chrome: {
  sidePanel: {
    setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>
    open(options: { windowId: number }): Promise<void>
  }
  declarativeNetRequest?: RequestRulesApi
}

installReaderBackground(browser)
installPickerBackground(browser)
installStoryMenuBackground(browser)
installPageActionMenuBackground(browser, bundledPageActions(__ONCE_BUNDLED_ADDONS__), {
  openPanel: tab => {
    if (tab?.windowId === undefined) return
    chrome.sidePanel.open({ windowId: tab.windowId })
      .catch((error: unknown) => console.error("Unable to open the side panel", error))
  }
})
installKeyCommandBackground(browser)
installConnectionOriginBackground(chrome.declarativeNetRequest, browser.runtime.getURL("/"))
  .catch((error: unknown) => console.error("Unable to install the connection request rules", error))

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) => console.error("Unable to configure the side panel", error))

/**
 * Chrome has no `_execute_sidebar_action`, so the panel gets a named command
 * instead. sidePanel.open() needs a user gesture and a keyboard command is one,
 * but only while the gesture lasts — so the window comes from the tab the
 * listener is handed, never from an awaited lookup that would outlive it.
 *
 * The suggested key matches the Firefox sidebar shortcut. Chrome owns it from
 * here: the user rebinds it at chrome://extensions/shortcuts, not in Once.
 */
browser.commands.onCommand.addListener((command, tab) => {
  if (command !== "open-side-panel") return
  const windowId = tab?.windowId
  if (windowId === undefined) return
  chrome.sidePanel
    .open({ windowId })
    .catch((error: unknown) => console.error("Unable to open the side panel", error))
})

installStoryNavigationBackground(browser)
