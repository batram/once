import {
  app,
  autoUpdater,
  BrowserWindow,
  Rectangle,
  Session,
  protocol,
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
import { BROWSER_SESSION_PARTITION, BrowserCoordinator } from "./TabManager"
import { OFFSCREEN_TEST_POSITION, isBackgroundMode } from "./browser/WindowLifecycle"
import {
  configureReaderProtocol,
  readerScheme
} from "./ReaderProtocol"
import {
  configureErrorPageProtocol,
  errorPageScheme
} from "./browser/ErrorPageProtocol"
import {
  installedAppUserModelId,
  windowsInstanceIdentity
} from "./WindowsInstanceIdentity"
import { ExtensionRuntime } from "./extensions/ExtensionRuntime"
import { bundledExtensionRoot, resolveBundledExtensions } from "./extensions/bundledExtensions"
import { extensionScheme } from "./extensions/ExtensionScheme"
import { addonSandboxScheme, configureAddonSandboxProtocol } from "./AddonSandboxProtocol"
import { devAddonDirectories, readDevAddons, watchDevAddons } from "./devAddons"

declare const MAIN_WINDOW_WEBPACK_ENTRY: string
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string
declare const __ONCE_BUILD_CHANNEL__: "release" | "dev"
declare const __ONCE_BUILD_IDENTIFIER__: string

if (started) app.quit()

app.userAgentFallback = app.userAgentFallback.replace(/\sElectron\/[^\s]+/, "") +
  ` (Once/${app.getVersion()})`

// One call for every scheme: Electron keeps only the last registration, and
// a scheme left out of it loses its privileges (fetch on extension URLs
// failed for as long as each module registered its own).
protocol.registerSchemesAsPrivileged([
  readerScheme(),
  errorPageScheme(),
  extensionScheme(),
  addonSandboxScheme()
])

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
    // Off-screen in test runs so the window never lands on the developer's
    // virtual desktop; see showWindow().
    x: isBackgroundMode() ? OFFSCREEN_TEST_POSITION.x : bounds?.x,
    y: isBackgroundMode() ? OFFSCREEN_TEST_POSITION.y : bounds?.y,
    width: bounds?.width || 1280,
    height: bounds?.height || 800,
    minWidth: 760,
    minHeight: 480,
    show: false,
    // WS_EX_NOACTIVATE stops webContents.focus(), which tab activation calls,
    // from pulling the foreground away from the developer.
    focusable: !isBackgroundMode(),
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

function configureBrowserSession(): Session {
  const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION)
  configureReaderProtocol(browserSession)
  configureErrorPageProtocol(browserSession)
  browserSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === "fullscreen"
  })
  browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "fullscreen")
  })
  return browserSession
}

// Chromium builds a basic accessibility tree by itself once a UI Automation
// client touches the window - it arrives a moment after the first request, so
// a client that gives up on the first answer sees only the window's own chrome.
// That basic tree carries the tab strip, which is all a tool hunting for the
// audible tab needs. What it lacks are the screen reader extras (inline text
// boxes, relations, the full HTML) that this call switches on for every page;
// on a 60,000-node page those cost seconds of the main process and a hundred
// megabytes per tab, so they are opt-in: the "Screen reader support" setting,
// or ONCE_ACCESSIBILITY=1 for a scripted run.
async function configureAccessibility(settings: SecureSettings): Promise<void> {
  const enabled = process.env.ONCE_ACCESSIBILITY === "1" ||
    await settings.getAccessibility()
  if (enabled) app.setAccessibilitySupportEnabled(true)
}

app
  .whenReady()
  .then(async () => {
    const secureSettings = new SecureSettings()
    await configureAccessibility(secureSettings)
    const browserSession = configureBrowserSession()
    // The shell window runs in the default session; its add-on sandbox frames
    // load their page from this scheme. `ONCE_ADDONS` adds development add-on
    // directories in unpackaged builds only, like `ONCE_ELECTRON_EXTENSIONS`.
    const devAddonDirs = app.isPackaged ? [] : devAddonDirectories(process.env.ONCE_ADDONS)
    configureAddonSandboxProtocol(session.defaultSession, MAIN_WINDOW_WEBPACK_ENTRY, devAddonDirs)
    watchDevAddons(devAddonDirs, () => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(ELECTRON_IPC.addonsDevChanged)
      }
    })
    browserCoordinator = new BrowserCoordinator(
      createShellWindow,
      process.env.ONCE_ELECTRON_DISABLE_STORY_LOADING === "1"
        ? `${MAIN_WINDOW_WEBPACK_ENTRY}?disableStoryLoading`
        : MAIN_WINDOW_WEBPACK_ENTRY
    )
    startAutoUpdates()
    // Installed before the first window so its webRequest hooks see every
    // request a tab ever makes; the extensions themselves load after the
    // window is up so startup is not held for their background pages.
    const extensions = new ExtensionRuntime({
      browserSession,
      storageRoot: path.join(app.getPath("userData"), "extensions"),
      preloadPath: path.join(__dirname, "extension-preload.js"),
      contentPreloadPath: path.join(__dirname, "content-preload.js"),
      hooks: browserCoordinator.extensionHooks()
    })
    extensions.install()
    browserCoordinator.setPageProfileResolver((url) => extensions.pageProfile(url))
    registerIpcHandlers(secureSettings, {
      buildChannel: __ONCE_BUILD_CHANNEL__,
      buildIdentifier: __ONCE_BUILD_IDENTIFIER__,
      coordinator: browserCoordinator,
      extensions,
      devAddons: () => readDevAddons(devAddonDirs),
      getUpdateStatus: () => updateStatus,
      setUpdateStatus,
      updatesStarted: () => autoUpdatesStarted
    })
    extensions.onChanged(() => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(ELECTRON_IPC.extensionsChanged)
      }
    })
    await browserCoordinator.createWindow()
    void extensions.loadBundled(resolveBundledExtensions(bundledExtensionRoot({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    })))

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
