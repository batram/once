import {
  app,
  BrowserWindow,
  ipcMain,
  IpcMainInvokeEvent,
  net,
  session
} from "electron"
import started from "electron-squirrel-startup"
import {
  ELECTRON_IPC,
  ElectronFetchRequest,
  ElectronFetchResponse,
  ElectronRect
} from "@once/platform-electron/bridge"
import { SecureSettings } from "./SecureSettings"
import { TabManager } from "./TabManager"

declare const MAIN_WINDOW_WEBPACK_ENTRY: string
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string

if (started) app.quit()

if (process.env.ONCE_ELECTRON_TEST_USER_DATA) {
  app.setPath("userData", process.env.ONCE_ELECTRON_TEST_USER_DATA)
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()

let mainWindow: BrowserWindow | null = null
let tabManager: TabManager | null = null

function assertTrusted(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error("Untrusted IPC sender")
  }
}

function manager(event: IpcMainInvokeEvent): TabManager {
  assertTrusted(event)
  if (!tabManager) throw new Error("Tab manager is unavailable")
  return tabManager
}

function registerIpc(settings: SecureSettings): void {
  ipcMain.handle(
    ELECTRON_IPC.fetch,
    async (event, request: ElectronFetchRequest): Promise<ElectronFetchResponse> => {
      assertTrusted(event)
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

  ipcMain.handle(ELECTRON_IPC.tabsGetAll, (event) => manager(event).getAll())
  ipcMain.handle(ELECTRON_IPC.tabsOpenUrl, (event, url: string, target: string) =>
    manager(event).openUrl(url, target)
  )
  ipcMain.handle(ELECTRON_IPC.tabsCreate, (event, url?: string, active?: boolean) =>
    manager(event).create(url, active)
  )
  ipcMain.handle(ELECTRON_IPC.tabsActivate, (event, id: string) =>
    manager(event).activate(id)
  )
  ipcMain.handle(ELECTRON_IPC.tabsClose, (event, id: string) =>
    manager(event).close(id)
  )
  ipcMain.handle(ELECTRON_IPC.tabsNavigate, (event, id: string, url: string) =>
    manager(event).navigate(id, url)
  )
  ipcMain.handle(ELECTRON_IPC.tabsBack, (event, id: string) =>
    manager(event).back(id)
  )
  ipcMain.handle(ELECTRON_IPC.tabsForward, (event, id: string) =>
    manager(event).forward(id)
  )
  ipcMain.handle(ELECTRON_IPC.tabsReload, (event, id: string) =>
    manager(event).reload(id)
  )
  ipcMain.handle(ELECTRON_IPC.tabsStop, (event, id: string) =>
    manager(event).stop(id)
  )
  ipcMain.handle(ELECTRON_IPC.tabsSetBounds, (event, bounds: ElectronRect) =>
    manager(event).setBounds(bounds)
  )
}

async function createWindow(): Promise<void> {
  const browserSession = session.fromPartition("persist:once-browser-v2")
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#282a36",
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  })
  tabManager = new TabManager(mainWindow)

  mainWindow.once("ready-to-show", () => mainWindow?.show())
  mainWindow.on("closed", () => {
    mainWindow = null
    tabManager = null
  })
  await mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY)
  await tabManager.create("about:blank", true)
}

app
  .whenReady()
  .then(async () => {
    registerIpc(new SecureSettings())
    await createWindow()

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
