const { app, BrowserWindow, session, ipcMain } = require("electron")
const https = require("https")

require("electron-reload")(__dirname)
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
      webSecurity : false,
    },
  })
  win.removeMenu()

  // and load the index.html of the app.
  win.loadFile("index.html")
  win.webContents.openDevTools()

  ElectronBlocker.ElectronBlocker.fromPrebuiltAdsAndTracking(fetch).then(
    (blocker) => {
      blocker.enableBlockingInSession(session.defaultSession)

      win.webContents.session.webRequest.onHeadersReceived(
        { urls: ["*://*/*"] },
        (d, c) => {
          delete d.responseHeaders["X-Frame-Options"]
          delete d.responseHeaders["x-frame-options"]
          delete d.responseHeaders["content-security-policy"]
          delete d.responseHeaders["content-security-policy"]
          delete d.responseHeaders["Set-Cookie"]
          delete d.responseHeaders["Content-Security-Policy"]
          delete d.responseHeaders["X-Content-Type-Options"]
          delete d.responseHeaders["X-XSS-Protection"]

          c({
            cancel: false,
            responseHeaders: d.responseHeaders,
          })
        }
      )
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
