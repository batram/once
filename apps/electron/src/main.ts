import {
  app,
  autoUpdater,
  BrowserWindow,
  ipcMain,
  IpcMainInvokeEvent,
  net,
  Rectangle,
  session,
  shell
} from "electron"
import started from "electron-squirrel-startup"
import { UpdateSourceType, updateElectronApp } from "update-electron-app"
import { existsSync } from "node:fs"
import path from "path"
import {
  ELECTRON_IPC,
  ElectronBuildInfo,
  ElectronFetchRequest,
  ElectronFetchResponse,
  ElectronPoint,
  ElectronRect,
  ElectronRedirectRule,
  ElectronStoryMenuItem,
  ElectronUpdateStatus
} from "@once/platform-electron/bridge"
import { SecureSettings } from "./SecureSettings"
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

function assertTrusted(event: IpcMainInvokeEvent): void {
  if (!browserCoordinator) throw new Error("Browser coordinator is unavailable")
  browserCoordinator.requireWindow(event)
}

function requireExternalUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are allowed")
  }
  return url.toString()
}

function browser(event: IpcMainInvokeEvent): {
  coordinator: BrowserCoordinator
  window: ReturnType<BrowserCoordinator["requireWindow"]>
} {
  if (!browserCoordinator) throw new Error("Browser coordinator is unavailable")
  return {
    coordinator: browserCoordinator,
    window: browserCoordinator.requireWindow(event)
  }
}

function registerIpc(
  settings: SecureSettings,
  coordinator: BrowserCoordinator
): void {
  ipcMain.handle(ELECTRON_IPC.appGetBuildInfo, (event): ElectronBuildInfo => {
    assertTrusted(event)
    return {
      version: app.getVersion(),
      channel: __ONCE_BUILD_CHANNEL__,
      buildIdentifier: __ONCE_BUILD_IDENTIFIER__,
      platform: process.platform
    }
  })
  ipcMain.handle(
    ELECTRON_IPC.appGetUpdateStatus,
    (event): ElectronUpdateStatus => {
      assertTrusted(event)
      return updateStatus
    }
  )
  ipcMain.handle(
    ELECTRON_IPC.appCheckForUpdates,
    (event): ElectronUpdateStatus => {
      assertTrusted(event)
      if (!autoUpdatesStarted || ["checking", "available", "downloaded"]
        .includes(updateStatus.state)) {
        return updateStatus
      }

      setUpdateStatus({ state: "checking" })
      try {
        autoUpdater.checkForUpdates()
      } catch (error) {
        setUpdateStatus({
          state: "error",
          message: error instanceof Error ? error.message : "Update check failed"
        })
      }
      return updateStatus
    }
  )

  ipcMain.handle(
    ELECTRON_IPC.fetch,
    async (event, request: ElectronFetchRequest): Promise<ElectronFetchResponse> => {
      assertTrusted(event)
      if (process.env.ONCE_ELECTRON_DISABLE_NETWORK_FETCH === "1") {
        throw new Error("Network fetches are disabled for this Electron test")
      }
      const url = new URL(request.url)
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only HTTP and HTTPS requests are allowed")
      }
      if (!Array.isArray(request.headers) || typeof request.method !== "string") {
        throw new Error("Invalid fetch request")
      }

      const response = await net.fetch(url.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body ? Buffer.from(request.body) : undefined
      })
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()),
        body: await response.arrayBuffer()
      }
    }
  )

  ipcMain.handle(ELECTRON_IPC.getSyncUrl, (event) => {
    assertTrusted(event)
    return settings.getSyncUrl()
  })
  ipcMain.handle(ELECTRON_IPC.setSyncUrl, (event, value: string) => {
    assertTrusted(event)
    if (typeof value !== "string") throw new Error("Invalid sync URL")
    if (value) {
      const url = new URL(value)
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Sync URL must use HTTP or HTTPS")
      }
    }
    return settings.setSyncUrl(value)
  })
  ipcMain.handle(ELECTRON_IPC.getCacheTime, (event) => {
    assertTrusted(event)
    return settings.getCacheTime()
  })
  ipcMain.handle(ELECTRON_IPC.setCacheTime, (event, value: string) => {
    assertTrusted(event)
    if (typeof value !== "string") throw new Error("Invalid cache time")
    return settings.setCacheTime(value)
  })

  ipcMain.handle(ELECTRON_IPC.tabsGetAll, (event) => {
    const target = browser(event)
    return target.coordinator.getAll(target.window)
  })
  ipcMain.handle(ELECTRON_IPC.tabsOpenUrl, (event, url: string, target: string) => {
    const current = browser(event)
    return current.coordinator.openUrl(current.window, url, target)
  })
  ipcMain.handle(
    ELECTRON_IPC.tabsOpenReader,
    (event, html: string, sourceUrl: string, target: string) => {
      const current = browser(event)
      return current.coordinator.openReader(current.window, html, sourceUrl, target)
    }
  )
  ipcMain.handle(
    ELECTRON_IPC.tabsShowReaderError,
    (event, sourceUrl: string, error: string) => {
      const current = browser(event)
      return current.coordinator.showReaderError(current.window, sourceUrl, error)
    }
  )
  ipcMain.handle(ELECTRON_IPC.tabsCreate, (event, url?: string, active?: boolean) => {
    const current = browser(event)
    return current.coordinator.createTab(current.window, url, active)
  })
  ipcMain.handle(ELECTRON_IPC.tabsActivate, (event, id: string) => {
    const current = browser(event)
    return current.coordinator.activate(current.window, id)
  })
  ipcMain.handle(ELECTRON_IPC.tabsClose, (event, id: string) => {
    const current = browser(event)
    return current.coordinator.close(current.window, id)
  })
  ipcMain.handle(ELECTRON_IPC.tabsNavigate, (event, id: string, url: string) => {
    const current = browser(event)
    return current.coordinator.navigate(current.window, id, url)
  })
  ipcMain.handle(ELECTRON_IPC.tabsBack, (event, id: string) => {
    const current = browser(event)
    return current.coordinator.back(current.window, id)
  })
  ipcMain.handle(ELECTRON_IPC.tabsForward, (event, id: string) => {
    const current = browser(event)
    return current.coordinator.forward(current.window, id)
  })
  ipcMain.handle(ELECTRON_IPC.tabsReload, (event, id: string) => {
    const current = browser(event)
    return current.coordinator.reload(current.window, id)
  })
  ipcMain.handle(ELECTRON_IPC.tabsStop, (event, id: string) => {
    const current = browser(event)
    return current.coordinator.stop(current.window, id)
  })
  ipcMain.handle(ELECTRON_IPC.tabsDuplicate, (event, id: string) => {
    const current = browser(event)
    return current.coordinator.duplicate(current.window, id)
  })
  ipcMain.handle(
    ELECTRON_IPC.tabsReorder,
    (event, id: string, beforeId?: string) => {
      const current = browser(event)
      return current.coordinator.reorder(current.window, id, beforeId)
    }
  )
  ipcMain.handle(
    ELECTRON_IPC.tabsMoveHere,
    (event, id: string, beforeId?: string) => {
      const current = browser(event)
      return current.coordinator.moveHere(current.window, id, beforeId)
    }
  )
  ipcMain.handle(
    ELECTRON_IPC.tabsDetach,
    (event, id: string, point?: ElectronPoint) => {
      const current = browser(event)
      return current.coordinator.detach(current.window, id, point)
    }
  )
  ipcMain.handle(ELECTRON_IPC.tabsToggleMuted, (event, id: string) => {
    const current = browser(event)
    return current.coordinator.toggleMuted(current.window, id)
  })
  ipcMain.handle(ELECTRON_IPC.tabsOpenDroppedUrls, (event, urls: string[]) => {
    const current = browser(event)
    return current.coordinator.openDroppedUrls(current.window, urls)
  })
  ipcMain.handle(ELECTRON_IPC.tabsStartSourcePicker, (event) => {
    const current = browser(event)
    return current.coordinator.startSourcePicker(current.window)
  })
  ipcMain.handle(
    ELECTRON_IPC.tabsShowMenu,
    (event, id: string, point: ElectronPoint) => {
      const current = browser(event)
      return current.coordinator.showTabMenu(current.window, id, point)
    }
  )
  ipcMain.handle(ELECTRON_IPC.tabsSetBounds, (event, bounds: ElectronRect) => {
    const current = browser(event)
    return current.coordinator.setBounds(current.window, bounds)
  })
  ipcMain.handle(
    ELECTRON_IPC.storyMenuShow,
    (event, items: ElectronStoryMenuItem[], point: ElectronPoint) => {
      const current = browser(event)
      return current.coordinator.showStoryMenu(current.window, items, point)
    }
  )
  ipcMain.handle(ELECTRON_IPC.storyMenuOpenExternal, (event, url: string) => {
    assertTrusted(event)
    return shell.openExternal(requireExternalUrl(url))
  })
  ipcMain.handle(ELECTRON_IPC.storyMenuOpenWindow, (event, url: string) => {
    assertTrusted(event)
    return coordinator
      .createWindow({ url: requireExternalUrl(url) })
      .then(() => undefined)
  })
  ipcMain.handle(
    ELECTRON_IPC.windowSetFullscreen,
    (event, fullscreen: boolean) => {
      const current = browser(event)
      return current.coordinator.setFullscreen(current.window, fullscreen)
    }
  )
  ipcMain.handle(
    ELECTRON_IPC.windowSetRedirects,
    (event, redirects: ElectronRedirectRule[]) => {
      assertTrusted(event)
      return coordinator.setRedirects(redirects)
    }
  )
  ipcMain.handle(ELECTRON_IPC.windowSetBackgroundColor, (event, color: string) => {
    const current = browser(event)
    return current.coordinator.setBackgroundColor(current.window, color)
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
    registerIpc(new SecureSettings(), browserCoordinator)
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
