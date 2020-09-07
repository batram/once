const { app, BrowserWindow, session, ipcMain } = require("electron")
const path = require("path")

require("electron-reload")(path.join(__dirname))

const ElectronBlocker = require("@cliqz/adblocker-electron")
const fetch = require("cross-fetch")

function createWindow() {
  // Create the browser window.
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: true,
      webSecurity: false,
      webviewTag: true,
    },
    icon: __dirname + "/imgs/icons/mipmap-mdpi/ic_launcher.png",
  })

  win.removeMenu()
  //win.webContents.session.setProxy({ proxyRules: "socks5://127.0.0.1:9150" })

  // and load the index.html of the app.
  win.loadFile("app/index.html")

  if (process.env.LDEV == "1") {
    win.webContents.openDevTools()
  }

  ElectronBlocker.ElectronBlocker.fromPrebuiltAdsAndTracking(fetch).then(
    (blocker) => {
      blocker.enableBlockingInSession(session.fromPartition("moep"))
    }
  )

  win.webContents.on("found-in-page", (e, result) => {
    if (result.finalUpdate) {
      win.webContents.stopFindInPage("keepSelection")
    }
  })
  ipcMain.on("search-text", (e, arg) => {
    win.webContents.findInPage(arg)
  })
}

app.whenReady().then(() => {
  createWindow()
})
