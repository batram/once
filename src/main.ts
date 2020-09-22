/* eslint-disable @typescript-eslint/no-var-requires */
import {
  app,
  BrowserWindow,
  session,
  ipcMain,
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
  // eslint-disable-next-line no-var
  var paths: {
    icon_path: string
    main_window_preload: string
    main_window_html: string
    tab_view_preload: string
    tab_view_html: string
    moep_session_preload: string
  }
}

if (process.env.LDEV == "1") {
  require("electron-reload")(path.join(__dirname))
}

global.paths = {
  icon_path: path.join(
    __dirname,
    "static",
    "imgs",
    "icons",
    "mipmap-mdpi",
    "ic_launcher.png"
  ),
  moep_session_preload: path.join(
    __dirname,
    "js",
    "view",
    "moep_session_preload.js"
  ),

  main_window_html: path.join(__dirname, "static", "main_window.html"),
  main_window_preload: path.join(
    __dirname,
    "js",
    "view",
    "main_window_preload.js"
  ),

  tab_view_html: path.join(__dirname, "static", "webtab.html"),
  tab_view_preload: path.join(__dirname, "js", "view", "tab_view_preload.js"),
}

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
      preload: global.paths.main_window_preload,
    },
    autoHideMenuBar: true,
    icon: paths.icon_path,
  })

  fullscreen.main_listener()
  tabbed_out.tab_listeners(win)

  ipcMain.on("theme", (event, data) => {
    nativeTheme.themeSource = data
  })

  //win.webContents.session.setProxy({ proxyRules: "socks5://127.0.0.1:9150" })

  win.loadFile(global.paths.main_window_html)

  adblocker.ElectronBlocker.fromPrebuiltAdsAndTracking(
    require("cross-fetch")
  ).then((blocker: adblocker.ElectronBlocker) => {
    blocker.enableBlockingInSession(session.fromPartition("moep"))
  })

  app.on("before-quit", (event) => {
    console.log("byebye")
    event.preventDefault()
    ipcMain.on("alive", (x) => {
      const wc = webContents.fromId(x.sender.id)

      console.log("alive", wc.id, wc.isDestroyed())
    })

    setTimeout(() => {
      process.exit(0)
    }, 2000)
  })
}

app.on("window-all-closed", () => {
  console.log("here we are now all alone")
  const allv = BrowserView.getAllViews()
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
