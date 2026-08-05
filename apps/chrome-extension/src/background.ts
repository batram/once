import browser from "webextension-polyfill"
import { installReaderBackground } from "@once/webext-shell/dist/readerBackground"
import { installPickerBackground } from "@once/webext-shell/dist/pickerBackground"
import { installStoryMenuBackground } from "@once/webext-shell/dist/storyMenuBackground"
import { installKeyCommandBackground } from "@once/webext-shell/dist/keyCommandBackground"

installReaderBackground(browser)
installPickerBackground(browser)
installStoryMenuBackground(browser)
installKeyCommandBackground(browser)

// Chrome-only API, not covered by the Firefox-flavored polyfill types.
declare const chrome: {
  sidePanel: {
    setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>
    open(options: { windowId: number }): Promise<void>
  }
}

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
