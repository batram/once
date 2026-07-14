import browser from "webextension-polyfill"
import { installReaderBackground } from "@once/webext-shell/dist/readerBackground"
import { installPickerBackground } from "@once/webext-shell/dist/pickerBackground"

// Firefox MV3 backgrounds are non-persistent event pages: every listener
// must be registered synchronously in the first turn of the event loop,
// or it will not be dispatched when the script wakes up for an event.

browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle()
})

browser.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "once_undo") {
    void browser.runtime.sendMessage({ onceCommand: "history", action: "undo" })
  }
})

// Menus persist across background restarts, so create them on
// install/update instead of removeAll+create on every wakeup.
browser.runtime.onInstalled.addListener(() => {
  void browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: "once_undo",
      title: "undo",
      contexts: ["all"],
      viewTypes: ["sidebar"],
      documentUrlPatterns: [browser.runtime.getURL("/static/sidepanel.html")]
    })
  })
})

installReaderBackground(browser)
installPickerBackground(browser)
