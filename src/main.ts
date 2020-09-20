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
import * as tabbed_out from "./js/view/tabbed_out"
import * as webcontents_enhancer from "./js/view/webcontents_enhancer"

declare global {
  var icon_path: string
  var main_window_preload: string
  var main_window_html: string
  var tab_view_preload: string
  var tab_view_html: string
  var moep_session_preload: string
}

if (process.env.LDEV == "1") {
  require("electron-reload")(path.join(__dirname))
}

global.icon_path = path.join(
  __dirname,
  "static",
  "imgs",
  "icons",
  "mipmap-mdpi",
  "ic_launcher.png"
)

global.moep_session_preload = path.join(
  __dirname,
  "js",
  "view",
  "moep_session_preload.js"
)

global.main_window_html = path.join(__dirname, "static", "main_window.html")
global.main_window_preload = path.join(
  __dirname,
  "js",
  "view",
  "main_window_preload.js"
)

global.tab_view_html = path.join(__dirname, "static", "webtab.html")
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
    autoHideMenuBar: true,
    icon: global.icon_path,
  })

  fullscreen.main_listener()
  tabbed_out.tab_listeners(win)

  ipcMain.on("theme", (event, data) => {
    nativeTheme.themeSource = data
  })

  //win.webContents.session.setProxy({ proxyRules: "socks5://127.0.0.1:9150" })

  win.loadFile(global.main_window_html)

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
  webcontents_enhancer.on_each()

  createWindow()
  process.on("uncaughtException", (x) => {
    //truncate errors
    console.log(JSON.stringify(x).substring(0, 500))
  })
  process.on("exit", console.log)
})
