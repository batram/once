import {
  app,
  BrowserWindow,
  session,
  ipcMain,
  dialog,
  webContents,
  BrowserView,
  nativeTheme,
} from "electron"

import * as path from "path"
import * as adblocker from "@cliqz/adblocker-electron"
import * as fullscreen from "./js/view/fullscreen"
import * as contextmenu from "./js/view/contextmenu"
import * as tabbed_out from "./js/view/tabbed_out"
import * as mouse_debugger_hook from "./js/view/debugger_hook"

declare global {
  var icon_path: string
  var main_window_preload: string
  var tab_view_preload: string
}

if (process.env.LDEV == "1") {
  require("electron-reload")(path.join(__dirname))
}

let icon_path = path.join(
  __dirname,
  "imgs",
  "icons",
  "mipmap-mdpi",
  "ic_launcher.png"
)

global.main_window_preload = path.join(
  __dirname,
  "js",
  "view",
  "main_window_preload.js"
)

global.tab_view_preload = path.join(
  __dirname,
  "js",
  "view",
  "tab_view_preload.js"
)

function createWindow() {
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
      preload: global.main_window_preload,
    },
    icon: icon_path,
  })

  fullscreen.main_listener()

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

  ipcMain.on("theme", (event, data) => {
    nativeTheme.themeSource = data
  })

  tabbed_out.tab_listeners()
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

  app.on("before-quit", (event) => {
    console.log("byebye")
    event.preventDefault()
    ipcMain.on("alive", (x) => {
      let wc = webContents.fromId(x.sender.id)

      console.log("alive", wc.id, wc.isDestroyed())
    })

    setTimeout((x) => {
      process.exit(0)
    }, 2000)
  })
}

app.on("window-all-closed", () => {
  console.log("here we are now all alone")
  let allv = BrowserView.getAllViews()
  allv.forEach((x) => {
    x.destroy()
  })
  app.quit()
})

app.whenReady().then(() => {
  createWindow()
  process.on("uncaughtException", (x) => {
    //truncate errors
    console.log(JSON.stringify(x).substring(0, 500))
  })
  process.on("exit", console.log)
})

//https://github.com/electron/electron/issues/12518#issuecomment-616155070
//https://www.electronjs.org/docs/api/web-contents#event-will-prevent-unload
app.on("web-contents-created", function (_event, webContents) {
  /*
  async function check_alive() {
    if (webContents.isDestroyed()) {
      return
    }

    let fae23 = await webContents.executeJavaScript(
      'if(window.require  != undefined) window.require("electron").ipcRenderer.send("alive"); window.require  != undefined'
    )
    let allv = BrowserView.getAllViews()

    // console.log("can js", fae23, allv.length)
    setTimeout(check_alive, 500)
  }

  setTimeout(check_alive, 500)
*/
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
