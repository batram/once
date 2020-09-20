import {
  app,
  BrowserView,
  BrowserWindow,
  dialog,
  ipcRenderer,
  session,
} from "electron"
import * as mouse_debugger_hook from "../view/debugger_hook"
import * as contextmenu from "../view/contextmenu"
import * as fullscreen from "../view/fullscreen"
import * as tabbed_out from "../view/tabbed_out"

export { on_each }

function on_each() {
  session.fromPartition("moep").setPreloads([global.moep_session_preload])

  app.on("web-contents-created", function (event, webContents) {
    //console.log("web-contents-created ", event, webContents.id)
    contextmenu.init_menu(webContents)

    webContents.on(
      "new-window",
      (event, url, frameName, disposition, additionalFeatures) => {
        event.preventDefault()
        console.log(
          "caught new-window",
          url,
          frameName,
          typeof disposition,
          additionalFeatures
        )
        webContents.send("tab_intercom", "open_in_new_tab", url)
        tabbed_out.tab_intercom({ sender: webContents }, "open_in_new_tab", url)
      }
    )

    webContents.on("will-navigate", (event, url) => {
      event.preventDefault()
      console.log("caught will-navigate", url)
      tabbed_out.tab_intercom({ sender: webContents }, "open_in_tab", url)
    })

    mouse_debugger_hook.history_nav(webContents)
    fullscreen.webview_key_catcher(webContents)

    webContents.on("will-prevent-unload", function (event) {
      console.log("will-prevent-unload")
      let win: BrowserWindow = BrowserWindow.fromWebContents(webContents)
      if (!win) {
        let view = BrowserView.fromWebContents(webContents)
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
