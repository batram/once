function initBackground() {
  console.log("moin background=? ", browser, browser.action)

  if (browser && browser.action && browser.sidebarAction) {
    browser.action.onClicked.addListener(() => {
      console.log("clicky")
      browser.sidebarAction.toggle()
    })
  }
}

initBackground()

browser.contextMenus.removeAll()
browser.contextMenus.create({
  id: "once_undo",
  title: "undo",
  contexts: ["all"],
  viewTypes: ["sidebar"],
  documentUrlPatterns: [browser.runtime.getURL("/static/sidepanel.html")],
})

browser.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "once_undo") {
    browser.runtime.sendMessage({
      onceCommand: "history",
      action: "undo",
    })
  }
})
