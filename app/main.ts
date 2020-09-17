import {
  app,
  BrowserWindow,
  session,
  ipcMain,
  dialog,
  webContents,
  BrowserView,
  nativeTheme,
  KeyboardInputEvent,
} from "electron"

import * as path from "path"
import * as adblocker from "@cliqz/adblocker-electron"
import * as fullscreen from "./js/view/fullscreen"
const contextmenu = require("./js/view/contextmenu")
const tabbed_out = require("./js/view/tabbed_out")

require("electron-reload")(path.join(__dirname))

let icon_path = path.join(
  __dirname,
  "imgs",
  "icons",
  "mipmap-mdpi",
  "ic_launcher.png"
)

function createWindow() {
  let main_window_preload = path.join(__dirname, "js", "main_window.js")

  // Create the browser window.
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    //frame: false,
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: false,
      webSecurity: false,
      webviewTag: true,
      preload: main_window_preload,
    },
    icon: icon_path,
  })

  ipcMain.on("fullscreen", (event, value) => {
    console.log("fullscreen", BrowserWindow, event, value)
    let win = BrowserWindow.getFocusedWindow()
    if (win) {
      let bw = win.getBrowserView()
      if (bw && !bw.isDestroyed()) {
        bw.webContents.send("fullscreen", value)
      }

      win.setFullScreen(value)
    }
  })

  ipcMain.on("get_attached_wc_id", (event) => {
    console.log("get_attached_view", event.sender.id)
    let window = BrowserWindow.fromWebContents(event.sender)
    if (window) {
      let attached_view = window.getBrowserView()
      if (attached_view && !attached_view.isDestroyed()) {
        let view_wc_id = attached_view.webContents.id
        event.returnValue = view_wc_id
        return
      }
    }

    event.returnValue = null
  })

  ipcMain.on("bound_attached", (event, wc_id, bounds) => {
    console.log("bound_attached", wc_id)
    let window = BrowserWindow.fromWebContents(event.sender)
    let attached_view = window.getBrowserView()
    if (attached_view && !attached_view.isDestroyed()) {
      let view_wc_id = attached_view.webContents.id
      if (view_wc_id == wc_id) {
        //console.log("bound_attached", event, view_wc_id, wc_id, bounds)
        attached_view.setBounds(bounds)
      }

      event.returnValue = view_wc_id
    }
  })

  ipcMain.on("end_me", (event) => {
    let view = BrowserView.fromWebContents(event.sender)
    if (view) {
      let window = BrowserWindow.fromBrowserView(view)
      if (window) {
        window.removeBrowserView(view)
        //event.sender.destroy()
      }
    }
  })

  ipcMain.on("get_parent_id", (event) => {
    let view = BrowserView.fromWebContents(event.sender)
    if (view) {
      let window = BrowserWindow.fromBrowserView(view)
      if (window) {
        event.returnValue = window.webContents.id
        return
      }
    }
    event.returnValue = null
  })

  ipcMain.on("no_more_tabs_can_i_go", (event) => {
    let windows = BrowserWindow.getAllWindows()
    if (windows && windows.length > 1) {
      //no, you stay
      return
      let window = BrowserWindow.fromWebContents(event.sender)
      if (window) {
        window.close()
      }
    }
  })

  ipcMain.on("tab_me_out", (event, data) => {
    console.log("tab_me_out", event, data)
    let view = BrowserView.fromWebContents(event.sender)
    if (view) {
      let window = BrowserWindow.fromBrowserView(view)
      if (window) {
        if (data.type == "main") {
          tabbed_out.pop_new_main(window, event.sender, data.offset)
        } else if (data.type == "notabs") {
          tabbed_out.pop_no_tabs(window, event.sender)
        }
      }
    }
  })

  ipcMain.on("theme", (event, data) => {
    nativeTheme.themeSource = data
  })

  ipcMain.on("attach_new_tab", (event) => {
    let view = tabbed_out.create_view(event.sender.id)
    if (view) {
      let window = BrowserWindow.fromWebContents(event.sender)
      if (window) {
        window.setBrowserView(view)
        console.log("attach_new_tab", event.sender.id, view.webContents.id)
        event.returnValue = view.webContents.id
      }
    }
    event.returnValue = null
  })

  ipcMain.on("attach_wc_id", (event, wc_id) => {
    let window = BrowserWindow.fromWebContents(event.sender)
    if (window) {
      console.log("attach_wc_id", event.sender.id, wc_id)
      let view_wc = webContents.fromId(wc_id)
      if (view_wc) {
        let view = BrowserView.fromWebContents(view_wc)
        if (view) {
          window.setBrowserView(view)

          view.webContents.send("attach", event.sender.id)

          console.log(
            "attach_wc_id",
            event.sender.id,
            wc_id,
            view.webContents.id
          )
          event.returnValue = view.webContents.id
          return
        }
      }
    }
    event.returnValue = null
  })
  /*
  win.on("close", (x) => {
    //kill all attached browserviews before navigation
    if (win && win.getBrowserViews().length != 0) {
      win.getBrowserViews().forEach((v) => {
        win.removeBrowserView(v)
        //v.destroy()
      })
    }
  })
*/
  win.removeMenu()
  //win.openDevTools()
  //win.webContents.session.setProxy({ proxyRules: "socks5://127.0.0.1:9150" })

  // and load the index.html of the app.
  win.loadFile(path.join(__dirname, "main_window.html"))

  adblocker.ElectronBlocker.fromPrebuiltAdsAndTracking(
    require("cross-fetch")
  ).then((blocker: any) => {
    blocker.enableBlockingInSession(session.fromPartition("moep"))
  })
}

app.on("window-all-closed", () => {
  console.log("here we are now all alone")

  app.exit()
})

app.whenReady().then(() => {
  createWindow()
})

//https://github.com/electron/electron/issues/12518#issuecomment-616155070
//https://www.electronjs.org/docs/api/web-contents#event-will-prevent-unload
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

  try {
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach()
    }
  } catch (e) {
    console.log(e)
  }
  webContents.debugger.on("message", function (event, method, params) {
    console.debug(event, method, params)
    if (method == "Runtime.bindingCalled") {
      let name = params.name
      let payload = params.payload

      if (name == "mhook") {
        if (payload == "3") {
          webContents.goBack()
        } else if (payload == "4") {
          webContents.goForward()
        }
      }
    }
  })

  webContents.debugger.sendCommand("Runtime.addBinding", {
    name: "mhook",
  })

  if (false) {
    webContents.debugger.sendCommand("Runtime.enable")
    webContents.debugger.sendCommand("Page.enable")
    webContents.debugger.sendCommand("Page.setLifecycleEventsEnabled", {
      enabled: true,
    })
  }

  webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      {
        let ß = window.mhook
        window.addEventListener("mousedown", (e) => {
          ß(e.button.toString())
        })
      }
      
      delete window.mhook
      `,
  })

  fullscreen.webview_key_catcher(webContents)

  /*
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
  }) */
})
