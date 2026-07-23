import browser from "webextension-polyfill"
import { installReaderBackground } from "@once/webext-shell/dist/readerBackground"
import { installPickerBackground } from "@once/webext-shell/dist/pickerBackground"
import { installStoryMenuBackground } from "@once/webext-shell/dist/storyMenuBackground"

// Firefox MV3 backgrounds are non-persistent event pages: every listener
// must be registered synchronously in the first turn of the event loop,
// or it will not be dispatched when the script wakes up for an event.

browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle()
})

installReaderBackground(browser)
installPickerBackground(browser)
installStoryMenuBackground(browser)
