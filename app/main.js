const {
  app,
  BrowserWindow,
  session,
  WebContents,
  App,
  Event,
  dialog,
} = require("electron")
const path = require("path")

require("electron-reload")(path.join(__dirname))

global.icon_path = path.join(
  __dirname,
  "imgs",
  "icons",
  "mipmap-mdpi",
  "ic_launcher.png"
)

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
    icon: global.icon_path,
  })

  win.removeMenu()
  //win.openDevTools()
  //win.webContents.session.setProxy({ proxyRules: "socks5://127.0.0.1:9150" })

  // and load the index.html of the app.
  win.loadFile("app/index.html")

  ElectronBlocker.ElectronBlocker.fromPrebuiltAdsAndTracking(fetch).then(
    (blocker) => {
      blocker.enableBlockingInSession(session.fromPartition("moep"))
    }
  )
}

app.whenReady().then(() => {
  createWindow()
})

//https://github.com/electron/electron/issues/12518#issuecomment-616155070
//https://www.electronjs.org/docs/api/web-contents#event-will-prevent-unload
app.on("web-contents-created", function (_event, webContents) {
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
