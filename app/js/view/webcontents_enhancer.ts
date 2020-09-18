import { app, BrowserWindow, dialog } from "electron"
import * as mouse_debugger_hook from "../view/debugger_hook"
import * as contextmenu from "../view/contextmenu"
import * as fullscreen from "../view/fullscreen"

export { on_each }

function on_each() {
  app.on("web-contents-created", function (_event, webContents) {
    contextmenu.init_menu(webContents)

    webContents.on("new-window", (event, url) => {
      event.preventDefault()
      console.log("caught new-window", url)
      webContents.send("open_in_new_tab", url)
      return false
    })

    webContents.on("will-navigate", (event, url) => {
      console.log("caught will-navigate", url)
      webContents.send("open_in_tab", url)
      return false
    })

    mouse_debugger_hook.history_nav(webContents)
    fullscreen.webview_key_catcher(webContents)

    webContents.on("will-prevent-unload", function (event) {
      const win = BrowserWindow.fromWebContents(webContents)
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
