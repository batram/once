async function initBackground() {
  browser.action.onClicked.addListener(() => {
    browser.sidebarAction.toggle()
  })

  await browser.contextMenus.removeAll()
  browser.contextMenus.create({
    id: "once_undo",
    title: "undo",
    contexts: ["all"],
    viewTypes: ["sidebar"],
    documentUrlPatterns: [browser.runtime.getURL("/static/sidepanel.html")],
  })
}

browser.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "once_undo") {
    browser.runtime.sendMessage({
      onceCommand: "history",
      action: "undo",
    })
  }
})

initBackground().catch((error: unknown) => {
  console.error("Unable to initialize the Firefox background page", error)
})
