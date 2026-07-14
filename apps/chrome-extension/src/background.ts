import browser from "webextension-polyfill"
import { installReaderBackground } from "@once/webext-shell/dist/readerBackground"
import { installPickerBackground } from "@once/webext-shell/dist/pickerBackground"

installReaderBackground(browser)
installPickerBackground(browser)

// Chrome-only API, not covered by the Firefox-flavored polyfill types.
declare const chrome: {
  sidePanel: {
    setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>
  }
}

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) => console.error("Unable to configure the side panel", error))
