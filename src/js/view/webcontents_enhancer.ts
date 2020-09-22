import { app, BrowserView, BrowserWindow, dialog, session } from "electron"
import * as mouse_debugger_hook from "../view/debugger_hook"
import * as contextmenu from "../view/contextmenu"
import * as fullscreen from "../view/fullscreen"
import { NavigationHandler } from "./NavigationHandler"

export { on_each }

function on_each(): void {
  session.fromPartition("moep").setPreloads([global.paths.moep_session_preload])

  app.on("web-contents-created", function (event, webContents) {
    //console.log("web-contents-created ", event, webContents.id)
    contextmenu.init_menu(webContents)

    new NavigationHandler(webContents)

    mouse_debugger_hook.history_nav(webContents)
    fullscreen.webview_key_catcher(webContents)

    webContents.on("will-prevent-unload", function (event) {
      console.log("will-prevent-unload")
      let win: BrowserWindow = BrowserWindow.fromWebContents(webContents)
      if (!win) {
        const view = BrowserView.fromWebContents(webContents)
        win = BrowserWindow.fromBrowserView(view)
      }
      const choice = dialog.showMessageBoxSync(win, {
        type: "question",
        buttons: ["Leave", "Stay"],
        title: "Do you want to leave this site?",
        message: "Changes you made may not be saved.",
        defaultId: 0,
        cancelId: 1,
      })
      const leave = choice === 0
      if (leave) {
        event.preventDefault()
      }
    })
  })
}
