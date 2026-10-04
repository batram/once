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

// Firefox uses a non-persistent event page: every listener
// must be registered synchronously in the first turn of the event loop,
// or it will not be dispatched when the script wakes up for an event.

browser.browserAction.onClicked.addListener(() => {
  browser.sidebarAction.toggle()
})

installReaderBackground(browser)
installPickerBackground(browser)
installStoryMenuBackground(browser)
installPageActionMenuBackground(browser, bundledPageActions(__ONCE_BUNDLED_ADDONS__))
installKeyCommandBackground(browser)
// Not in the polyfill's types; Firefox has had it in Manifest V2 since 113.
installConnectionOriginBackground(
  (browser as unknown as { declarativeNetRequest?: RequestRulesApi }).declarativeNetRequest,
  browser.runtime.getURL("/")
).catch((error: unknown) => console.error("Unable to install the connection request rules", error))
