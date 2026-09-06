import {
  app,
  autoUpdater,
  dialog,
  ipcMain,
  IpcMainInvokeEvent,
  net,
  session,
  shell
} from "electron"
import {
  ELECTRON_IPC,
  ElectronBuildInfo,
  ElectronDevAddon,
  ElectronExtensionSettings,
  ElectronFetchRequest,
  ElectronFetchResponse,
  ElectronPoint,
  ElectronRect,
  ElectronRedirectRule,
  ElectronStoryMenuItem,
  ElectronUpdateStatus
} from "@once/platform-electron/bridge"
import { SecureSettings } from "./SecureSettings"
import { BROWSER_SESSION_PARTITION, BrowserCoordinator } from "./TabManager"
import { ExtensionRuntime } from "./extensions/ExtensionRuntime"

interface IpcHandlerOptions {
  buildChannel: "release" | "dev"
  buildIdentifier: string
  coordinator: BrowserCoordinator
  extensions: ExtensionRuntime
  /** `ONCE_ADDONS` directories as main reads them; empty when packaged. */
  devAddons: () => ElectronDevAddon[]
  addAddonDirectory(directory: string): void
  removeAddonDirectory(directory: string): void
  getUpdateStatus: () => ElectronUpdateStatus
  setUpdateStatus: (status: ElectronUpdateStatus) => void
  updatesStarted: () => boolean
}

const connectionRequests = new Map<string, AbortController>()

function trusted(
  event: IpcMainInvokeEvent,
  coordinator: BrowserCoordinator
): void {
  coordinator.requireWindow(event)
}

function browser(event: IpcMainInvokeEvent, coordinator: BrowserCoordinator) {
  return {
    coordinator,
    window: coordinator.requireWindow(event)
  }
}

function externalUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are allowed")
  }
  return url.toString()
}

function registerAppHandlers(options: IpcHandlerOptions): void {
  const { coordinator } = options
  ipcMain.handle(ELECTRON_IPC.appGetBuildInfo, (event): ElectronBuildInfo => {
    trusted(event, coordinator)
    return {
      version: app.getVersion(),
      channel: options.buildChannel,
      buildIdentifier: options.buildIdentifier,
      platform: process.platform
    }
  })
  ipcMain.handle(ELECTRON_IPC.appGetUpdateStatus, (event) => {
    trusted(event, coordinator)
    return options.getUpdateStatus()
  })
  ipcMain.handle(ELECTRON_IPC.appCheckForUpdates, (event) => {
    trusted(event, coordinator)
    const status = options.getUpdateStatus()
    if (!options.updatesStarted() ||
      ["checking", "available", "downloaded"].includes(status.state)) {
      return status
    }
    options.setUpdateStatus({ state: "checking" })
    try {
      autoUpdater.checkForUpdates()
    } catch (error) {
      options.setUpdateStatus({
        state: "error",
        message: error instanceof Error ? error.message : "Update check failed"
      })
    }
    return options.getUpdateStatus()
  })
  ipcMain.handle(
    ELECTRON_IPC.fetch,
    async (event, request: ElectronFetchRequest): Promise<ElectronFetchResponse> => {
      trusted(event, coordinator)
      if (process.env.ONCE_ELECTRON_DISABLE_NETWORK_FETCH === "1") {
        throw new Error("Network fetches are disabled for this Electron test")
      }
      const url = new URL(request.url)
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Only HTTP and HTTPS requests are allowed")
      }
      if (!Array.isArray(request.headers) || typeof request.method !== "string") {
        throw new Error("Invalid fetch request")
      }
      if (request.credentials !== undefined && request.credentials !== "include") {
        throw new Error("Invalid fetch credentials")
      }
      if (request.redirect !== undefined && request.redirect !== "error") throw new Error("Invalid redirect policy")
      if (request.requestId !== undefined && !/^[a-zA-Z0-9-]{1,80}$/.test(request.requestId)) throw new Error("Invalid request ID")
      const key = request.requestId ? `${event.sender.id}:${request.requestId}` : ""
      const controller = new AbortController()
      if (key) connectionRequests.set(key, controller)
      // A request that wants the user's cookies goes through the session the
      // browser tabs use, since that is where the user logged in. Everything
      // else keeps the default session and, with it, no cookies at all.
      const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION)
      const fetchWith = request.credentials === "include"
        ? browserSession.fetch.bind(browserSession)
        : net.fetch
      try {
        const response = await fetchWith(url.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body ? Buffer.from(request.body) : undefined,
          credentials: request.credentials ?? "omit",
          redirect: request.redirect,
          signal: controller.signal
        })
        return {
          status: response.status,
          statusText: response.statusText,
          headers: Array.from(response.headers.entries()),
          body: await readFetchBody(response, request.redirect === "error")
        }
      } finally { if (key) connectionRequests.delete(key) }
    }
  )
  ipcMain.handle(ELECTRON_IPC.cancelFetch, (event, id: string) => {
    trusted(event, coordinator)
    connectionRequests.get(`${event.sender.id}:${id}`)?.abort()
  })
}

async function readFetchBody(response: Response, bounded: boolean): Promise<ArrayBuffer> {
  if (!bounded) return response.arrayBuffer()
  const chunks: Uint8Array[] = []
  let length = 0
  const reader = response.body?.getReader()
  if (!reader) return new ArrayBuffer(0)
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > 1024 * 1024) throw new Error("Response is too large")
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel().catch(() => undefined) }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return result.buffer
}

function registerSettingsHandlers(
  settings: SecureSettings,
  coordinator: BrowserCoordinator
): void {
  ipcMain.handle(ELECTRON_IPC.getSyncUrl, (event) => {
    trusted(event, coordinator)
    return settings.getSyncUrl()
  })
  ipcMain.handle(ELECTRON_IPC.setSyncUrl, (event, value: string) => {
    trusted(event, coordinator)
    if (typeof value !== "string") throw new Error("Invalid sync URL")
    if (value && !["http:", "https:"].includes(new URL(value).protocol)) {
      throw new Error("Sync URL must use HTTP or HTTPS")
    }
    return settings.setSyncUrl(value)
  })
  ipcMain.handle(ELECTRON_IPC.getCacheTime, (event) => {
    trusted(event, coordinator)
    return settings.getCacheTime()
  })
  ipcMain.handle(ELECTRON_IPC.setCacheTime, (event, value: string) => {
    trusted(event, coordinator)
    if (typeof value !== "string") throw new Error("Invalid cache time")
    return settings.setCacheTime(value)
  })
  ipcMain.handle(ELECTRON_IPC.getAccessibility, (event) => {
    trusted(event, coordinator)
    return settings.getAccessibility()
  })
  ipcMain.handle(ELECTRON_IPC.setAccessibility, async (event, enabled: boolean) => {
    trusted(event, coordinator)
    if (typeof enabled !== "boolean") throw new Error("Invalid accessibility flag")
    await settings.setAccessibility(enabled)
    app.setAccessibilitySupportEnabled(enabled)
  })
  ipcMain.handle(ELECTRON_IPC.getSecret, (event, key: string) => {
    trusted(event, coordinator)
    if (typeof key !== "string" || !key) throw new Error("Invalid secret key")
    return settings.getSecret(key)
  })
  ipcMain.handle(ELECTRON_IPC.setSecret, (event, key: string, value: string) => {
    trusted(event, coordinator)
    if (typeof key !== "string" || !key) throw new Error("Invalid secret key")
    if (typeof value !== "string") throw new Error("Invalid secret")
    return settings.setSecret(key, value)
  })
}

function registerTabNavigation(coordinator: BrowserCoordinator): void {
  ipcMain.handle(ELECTRON_IPC.tabsGetAll, (event) => {
    const target = browser(event, coordinator)
    return coordinator.getAll(target.window)
  })
  ipcMain.handle(ELECTRON_IPC.tabsOpenUrl, (event, url: string, target: string) => {
    const current = browser(event, coordinator)
    return coordinator.openUrl(current.window, url, target)
  })
  ipcMain.handle(
    ELECTRON_IPC.tabsOpenReader,
    (event, html: string, sourceUrl: string, target: string, tabId?: string) => {
      const current = browser(event, coordinator)
      return coordinator.openReader(current.window, html, sourceUrl, target, tabId)
    }
  )
  ipcMain.handle(
    ELECTRON_IPC.tabsShowReaderError,
    (event, sourceUrl: string, error: string, tabId?: string) => {
      const current = browser(event, coordinator)
      return coordinator.showReaderError(current.window, sourceUrl, error, tabId)
    }
  )
  ipcMain.handle(ELECTRON_IPC.tabsNavigate, (event, id: string, url: string) => {
    const current = browser(event, coordinator)
    return coordinator.navigate(current.window, id, url)
  })
  for (const [channel, action] of [
    [ELECTRON_IPC.tabsBack, "back"],
    [ELECTRON_IPC.tabsForward, "forward"],
    [ELECTRON_IPC.tabsReload, "reload"],
    [ELECTRON_IPC.tabsStop, "stop"]
  ] as const) {
    ipcMain.handle(channel, (event, id: string) => {
      const current = browser(event, coordinator)
      return coordinator[action](current.window, id)
    })
  }
}

function registerTabLifecycle(coordinator: BrowserCoordinator): void {
  ipcMain.handle(ELECTRON_IPC.tabsCreate, (event, url?: string, active?: boolean) => {
    const current = browser(event, coordinator)
    return coordinator.createTab(current.window, url, active)
  })
  for (const [channel, action] of [
    [ELECTRON_IPC.tabsActivate, "activate"],
    [ELECTRON_IPC.tabsClose, "close"],
    [ELECTRON_IPC.tabsDuplicate, "duplicate"],
    [ELECTRON_IPC.tabsToggleMuted, "toggleMuted"]
  ] as const) {
    ipcMain.handle(channel, (event, id: string) => {
      const current = browser(event, coordinator)
      return coordinator[action](current.window, id)
    })
  }
  ipcMain.handle(ELECTRON_IPC.tabsRestoreClosed, (event) => {
    const current = browser(event, coordinator)
    return coordinator.restoreClosedTab(current.window)
  })
  ipcMain.handle(ELECTRON_IPC.tabsReorder, (event, id: string, beforeId?: string) => {
    const current = browser(event, coordinator)
    return coordinator.reorder(current.window, id, beforeId)
  })
  ipcMain.handle(ELECTRON_IPC.tabsMoveHere, (event, id: string, beforeId?: string) => {
    const current = browser(event, coordinator)
    return coordinator.moveHere(current.window, id, beforeId)
  })
  ipcMain.handle(ELECTRON_IPC.tabsDetach, (event, id: string, point?: ElectronPoint) => {
    const current = browser(event, coordinator)
    return coordinator.detach(current.window, id, point)
  })
}

function registerTabTools(coordinator: BrowserCoordinator): void {
  ipcMain.handle(ELECTRON_IPC.tabsOpenDroppedUrls, (event, urls: string[]) => {
    const current = browser(event, coordinator)
    return coordinator.openDroppedUrls(current.window, urls)
  })
  ipcMain.handle(ELECTRON_IPC.tabsStartSourcePicker, (event, url?: string) => {
    const current = browser(event, coordinator)
    return coordinator.startSourcePicker(current.window, url)
  })
  ipcMain.handle(ELECTRON_IPC.tabsShowMenu, (event, id: string, point: ElectronPoint) => {
    const current = browser(event, coordinator)
    return coordinator.showTabMenu(current.window, id, point)
  })
  ipcMain.handle(ELECTRON_IPC.tabsSetBounds, (event, bounds: ElectronRect) => {
    const current = browser(event, coordinator)
    return coordinator.setBounds(current.window, bounds)
  })
  ipcMain.handle(ELECTRON_IPC.tabsFocusContent, (event) => {
    const current = browser(event, coordinator)
    return coordinator.focusContent(current.window)
  })
}

function registerStoryAndWindowHandlers(options: IpcHandlerOptions): void {
  const { coordinator } = options
  ipcMain.handle(
    ELECTRON_IPC.storyMenuShow,
    (event, items: ElectronStoryMenuItem[], point: ElectronPoint) => {
      const current = browser(event, coordinator)
      return coordinator.showStoryMenu(current.window, items, point)
    }
  )
  ipcMain.handle(ELECTRON_IPC.storyMenuOpenExternal, (event, url: string) => {
    trusted(event, coordinator)
    return shell.openExternal(externalUrl(url))
  })
  ipcMain.handle(ELECTRON_IPC.storyMenuOpenWindow, (event, url: string) => {
    trusted(event, coordinator)
    return coordinator.createWindow({ url: externalUrl(url) }).then(() => undefined)
  })
  ipcMain.handle(ELECTRON_IPC.windowCreate, (event) => {
    trusted(event, coordinator)
    return coordinator.createWindow().then(() => undefined)
  })
  ipcMain.handle(ELECTRON_IPC.windowFocusShell, (event) => {
    const current = browser(event, coordinator)
    return coordinator.focusShell(current.window)
  })
  ipcMain.handle(ELECTRON_IPC.windowSetForwardedKeys, (event, chords: string[]) => {
    const current = browser(event, coordinator)
    return coordinator.setForwardedKeys(current.window, chords)
  })
  ipcMain.handle(ELECTRON_IPC.windowSetFullscreen, (event, fullscreen: boolean) => {
    const current = browser(event, coordinator)
    return coordinator.setFullscreen(current.window, fullscreen)
  })
  ipcMain.handle(ELECTRON_IPC.windowSetRedirects, (event, redirects: ElectronRedirectRule[]) => {
    trusted(event, coordinator)
    return coordinator.setRedirects(redirects)
  })
  ipcMain.handle(ELECTRON_IPC.windowSetBackgroundColor, (event, color: string) => {
    const current = browser(event, coordinator)
    return coordinator.setBackgroundColor(current.window, color)
  })
}

function registerExtensionHandlers(options: IpcHandlerOptions): void {
  const { coordinator, extensions } = options
  ipcMain.handle(ELECTRON_IPC.extensionsList, (event) => {
    const current = browser(event, coordinator)
    const active = current.window.activeId
      ? coordinator.activeTabContentsId(current.window)
      : undefined
    return extensions.extensionInfos(active)
  })
  ipcMain.handle(
    ELECTRON_IPC.extensionsOpenPopup,
    (event, host: string, anchor: ElectronRect) => {
      const current = browser(event, coordinator)
      if (typeof host !== "string" || !anchor ||
        ![anchor.x, anchor.y, anchor.width, anchor.height].every(Number.isFinite)) {
        throw new Error("Invalid popup request")
      }
      extensions.openPopup(current.window.window, host, anchor)
    }
  )
  ipcMain.handle(
    ELECTRON_IPC.extensionsApplySettings,
    (event, settings: ElectronExtensionSettings) => {
      trusted(event, coordinator)
      return extensions.applySettings(settings)
    }
  )
}

export function registerIpcHandlers(
  settings: SecureSettings,
  options: IpcHandlerOptions
): void {
  registerAppHandlers(options)
  registerExtensionHandlers(options)
  ipcMain.handle(ELECTRON_IPC.addonsDevList, (event) => {
    trusted(event, options.coordinator)
    return options.devAddons()
  })
  ipcMain.handle(ELECTRON_IPC.addonsPickDirectory, async (event) => {
    const current = browser(event, options.coordinator)
    const selection = await dialog.showOpenDialog(current.window.window, { title: "Load Once addon directory", properties: ["openDirectory"] })
    if (!selection.canceled && selection.filePaths[0]) options.addAddonDirectory(selection.filePaths[0])
  })
  ipcMain.handle(ELECTRON_IPC.addonsRemoveDirectory, (event, directory: string) => {
    trusted(event, options.coordinator)
    if (typeof directory !== "string") throw new Error("Invalid directory")
    options.removeAddonDirectory(directory)
  })
  registerSettingsHandlers(settings, options.coordinator)
  registerTabNavigation(options.coordinator)
  registerTabLifecycle(options.coordinator)
  registerTabTools(options.coordinator)
  registerStoryAndWindowHandlers(options)
}
