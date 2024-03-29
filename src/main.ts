/* eslint-disable @typescript-eslint/no-var-requires */
import { app, BrowserWindow, ipcMain, webContents } from "electron"

import * as path from "path"
//import * as adblocker from "@cliqz/adblocker-electron"
import * as fullscreen from "./js/view/fullscreen"
import * as tabbed_out from "./js/view/tabbed_out"
import * as webcontents_enhancer from "./js/view/webcontents_enhancer"
import * as presenters_backend from "./js/view/presenters_backend"
import { StoryMap } from "./js/data/StoryMap"
import { OnceSettings } from "./js/OnceSettings"

declare global {
  // eslint-disable-next-line no-var
  var paths: {
    icon_path: string
    main_window_preload: string
    main_window_html: string
    tab_view_preload: string
    tab_view_html: string
    moep_session_preload: string
    pouchdb_path: string
    nosync_path: string
    sync_url_file: string
  }
}

if (process.env.LDEV == "1") {
  const dev_name = "once_dev"
  app.setName(dev_name)
  app.setPath("userData", path.join(app.getPath("appData"), dev_name))
  // require("electron-reload")(path.join(__dirname))
}

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
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
  pouchdb_path: path.join(app.getPath("userData"), ".once_db"),
  nosync_path: path.join(app.getPath("userData"), ".nosync"),
  sync_url_file: path.join(app.getPath("userData"), ".nosync", "sync_url"),
}

function createWindow() {
  // Create the browser window.
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    //frame: false,
    webPreferences: {
      nodeIntegration: true,
      //enableRemoteModule: false,
      contextIsolation: false,
      webSecurity: false,
      webviewTag: true,
      preload: global.paths.main_window_preload,
    },
    autoHideMenuBar: true,
    icon: paths.icon_path,
  })
  win.loadFile(global.paths.main_window_html)

  app.on("second-instance", () => {
    if (win) {
      tabbed_out.new_main(win)
    }
  })

  new OnceSettings()
  new StoryMap()

  fullscreen.main_listener()
  tabbed_out.tab_listeners(win)

  presenters_backend.custom_protocol()

  //win.webContents.session.setProxy({ proxyRules: "socks5://127.0.0.1:9150" })
  /*
  adblocker.ElectronBlocker.fromPrebuiltAdsAndTracking(
    require("cross-fetch")
  ).then((blocker: adblocker.ElectronBlocker) => {
    blocker.enableBlockingInSession(session.fromPartition("moep"))
  })
*/
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
  app.quit()
})

app.whenReady().then(() => {
  process.on("uncaughtException", (e) => {
    console.log("err caught", e)
  })

  process.on("unhandledRejection", (e) => {
    console.log("unhandledRejection", e)
    return false
  })

  webcontents_enhancer.on_each()
  createWindow()
})
