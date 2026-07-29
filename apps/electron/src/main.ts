import {
  app,
  autoUpdater,
  BrowserWindow,
  Rectangle,
  session
} from "electron"
import started from "electron-squirrel-startup"
import { UpdateSourceType, updateElectronApp } from "update-electron-app"
import { existsSync } from "node:fs"
import path from "path"
import {
  ELECTRON_IPC,
  ElectronUpdateStatus
} from "@once/platform-electron/bridge"
import { SecureSettings } from "./SecureSettings"
import { registerIpcHandlers } from "./IpcHandlers"
import { BrowserCoordinator } from "./TabManager"
import {
  configureReaderProtocol,
  registerReaderScheme
} from "./ReaderProtocol"
import {
  configureErrorPageProtocol,
  registerErrorPageScheme
} from "./browser/ErrorPageProtocol"
import {
  installedAppUserModelId,
  windowsInstanceIdentity
} from "./WindowsInstanceIdentity"

declare const MAIN_WINDOW_WEBPACK_ENTRY: string
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string
declare const __ONCE_BUILD_CHANNEL__: "release" | "dev"
declare const __ONCE_BUILD_IDENTIFIER__: string

if (started) app.quit()

app.userAgentFallback = app.userAgentFallback.replace(/\sElectron\/[^\s]+/, "") +
  ` (Once/${app.getVersion()})`

registerReaderScheme()
registerErrorPageScheme()

if (process.env.ONCE_ELECTRON_TEST_USER_DATA) {
  app.setPath("userData", process.env.ONCE_ELECTRON_TEST_USER_DATA)
}

if (process.platform === "win32") {
  const updateExecutable = path.resolve(
    path.dirname(process.execPath),
    "..",
    "Update.exe"
  )
  const instanceIdentity = process.env.ONCE_ELECTRON_TEST_USER_DATA
    ? null
    : windowsInstanceIdentity({
      buildChannel: __ONCE_BUILD_CHANNEL__,
      executablePath: process.execPath,
      isPackaged: app.isPackaged,
      platform: process.platform,
      squirrelUpdateExists: existsSync(updateExecutable),
      userDataPath: app.getPath("userData")
    })

  if (instanceIdentity) {
    app.setPath("userData", instanceIdentity.userDataPath)
  }
  app.setAppUserModelId(
    instanceIdentity?.appUserModelId ??
      installedAppUserModelId(__ONCE_BUILD_CHANNEL__)
  )
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()

let browserCoordinator: BrowserCoordinator | null = null
let autoUpdatesStarted = false
let updateStatus: ElectronUpdateStatus = {
  state: "disabled",
  message: "Updates are available in installed release builds."
}

function setUpdateStatus(status: ElectronUpdateStatus): void {
  updateStatus = status
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(ELECTRON_IPC.appUpdateStatusChanged, status)
    }
  }
}

function trackAutoUpdateStatus(): void {
  autoUpdater.on("checking-for-update", () => {
    setUpdateStatus({ state: "checking" })
  })
  autoUpdater.on("update-available", () => {
    setUpdateStatus({ state: "available" })
  })
  autoUpdater.on("update-not-available", () => {
    setUpdateStatus({ state: "current" })
  })
  autoUpdater.on("update-downloaded", () => {
    setUpdateStatus({ state: "downloaded" })
  })
  autoUpdater.on("error", (error) => {
    const message = /squirrel/i.test(error.message)
      ? "Install Once using the Setup executable to enable updates."
      : error.message
    setUpdateStatus({ state: "error", message })
  })
}

function updateUnavailableMessage(): string | null {
  if (process.platform !== "win32") {
    return "Automatic updates are currently supported on Windows."
  }
  if (!app.isPackaged || __ONCE_BUILD_CHANNEL__ !== "release" ||
    process.env.ONCE_ELECTRON_DISABLE_NETWORK_FETCH === "1") {
    return "Updates are available in installed release builds."
  }
  if (process.argv.includes("--squirrel-firstrun")) {
    return "Updates will be available after installation finishes."
  }

  const updateExecutable = path.resolve(
    path.dirname(process.execPath),
    "..",
    "Update.exe"
  )
  if (!existsSync(updateExecutable)) {
    return "Install Once using the Setup executable to enable updates."
  }
  return null
}

function startAutoUpdates(): void {
  const unavailableMessage = updateUnavailableMessage()
  if (unavailableMessage) {
    setUpdateStatus({ state: "disabled", message: unavailableMessage })
    return
  }

  autoUpdatesStarted = true
  setUpdateStatus({ state: "idle" })
  trackAutoUpdateStatus()
  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.ElectronPublicUpdateService,
      repo: "batram/once"
    },
    updateInterval: "1 hour"
  })
}

function createShellWindow(bounds?: Rectangle): BrowserWindow {
  return new BrowserWindow({
    // Packaged builds get their icon from the executable (release or dev per
    // forge.config.js); unpackaged dev runs load the dev logo from the repo.
    icon: app.isPackaged
      ? undefined
      : path.join(
        app.getAppPath(),
        "../../packages/ui-web/public/static/imgs/icons/mipmap-mdpi/ic_launcher_dev.ico"
      ),
    x: bounds?.x,
    y: bounds?.y,
    width: bounds?.width || 1280,
    height: bounds?.height || 800,
    minWidth: 760,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: process.platform !== "darwin" ? {
      color: "#726464",      
      symbolColor: "#ffffff",
      height: 29            
    } : false,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  })
}

function configureBrowserSession(): void {
  const browserSession = session.fromPartition("persist:once-browser-v2")
  configureReaderProtocol(browserSession)
  configureErrorPageProtocol(browserSession)
  browserSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === "fullscreen"
  })
  browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "fullscreen")
  })
}

app
  .whenReady()
  .then(async () => {
    configureBrowserSession()
    browserCoordinator = new BrowserCoordinator(
      createShellWindow,
      process.env.ONCE_ELECTRON_DISABLE_STORY_LOADING === "1"
        ? `${MAIN_WINDOW_WEBPACK_ENTRY}?disableStoryLoading`
        : MAIN_WINDOW_WEBPACK_ENTRY
    )
    startAutoUpdates()
    registerIpcHandlers(new SecureSettings(), {
      buildChannel: __ONCE_BUILD_CHANNEL__,
      buildIdentifier: __ONCE_BUILD_IDENTIFIER__,
      coordinator: browserCoordinator,
      getUpdateStatus: () => updateStatus,
      setUpdateStatus,
      updatesStarted: () => autoUpdatesStarted
    })
    await browserCoordinator.createWindow()

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void browserCoordinator?.createWindow()
      }
    })
  })
  .catch((error) => {
    console.error("Once failed to start", error)
    app.exit(1)
  })

process.on("uncaughtException", (error) => {
  console.error("Uncaught main-process error", error)
})

process.on("unhandledRejection", (error) => {
  console.error("Unhandled main-process rejection", error)
})

app.on("second-instance", () => {
  void browserCoordinator?.createWindow()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
