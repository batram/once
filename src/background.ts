//TODO: split presenter into packages with forground and background
//import * as presenters_backend from "./js/view/presenters_backend"
import { StoryMap } from "@once/core"
import { OnceSettings } from "@once/core"

function iniBackground() {
  new OnceSettings()
  new StoryMap()

  //presenters_backend.custom_protocol()

  console.log("moin background=? ", browser, browser.action)

  if (browser && browser.action && browser.sidebarAction)
    browser.action.onClicked.addListener(() => {
      console.log("clicky")
      browser.sidebarAction.toggle()
    })
}

iniBackground()

browser.contextMenus.removeAll()
browser.contextMenus.create({
  id: "once_undo",
  title: "undo",
  contexts: ["all"],
  viewTypes: ["sidebar"],
  documentUrlPatterns: [browser.runtime.getURL("/static/sidepanel.html")]
})
