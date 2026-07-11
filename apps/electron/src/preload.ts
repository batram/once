import { contextBridge, ipcRenderer } from "electron"
import {
  ELECTRON_IPC,
  ElectronBridge,
  ElectronFetchRequest,
  ElectronPoint,
  ElectronRect,
  ElectronRedirectRule,
  ElectronTabState
} from "@once/platform-electron/bridge"

const bridge: ElectronBridge = {
  app: {
    getBuildInfo: () => ipcRenderer.invoke(ELECTRON_IPC.appGetBuildInfo)
  },
  fetch(request: ElectronFetchRequest) {
    return ipcRenderer.invoke(ELECTRON_IPC.fetch, request)
  },
  settings: {
    getSyncUrl: () => ipcRenderer.invoke(ELECTRON_IPC.getSyncUrl),
    setSyncUrl: (value) => ipcRenderer.invoke(ELECTRON_IPC.setSyncUrl, value),
    getCacheTime: () => ipcRenderer.invoke(ELECTRON_IPC.getCacheTime),
    setCacheTime: (value) =>
      ipcRenderer.invoke(ELECTRON_IPC.setCacheTime, value)
  },
  tabs: {
    getAll: () => ipcRenderer.invoke(ELECTRON_IPC.tabsGetAll),
    openUrl: (url, target) =>
      ipcRenderer.invoke(ELECTRON_IPC.tabsOpenUrl, url, target),
    openReader: (html, sourceUrl, target) =>
      ipcRenderer.invoke(ELECTRON_IPC.tabsOpenReader, html, sourceUrl, target),
    create: (url, active) =>
      ipcRenderer.invoke(ELECTRON_IPC.tabsCreate, url, active),
    activate: (id) => ipcRenderer.invoke(ELECTRON_IPC.tabsActivate, id),
    close: (id) => ipcRenderer.invoke(ELECTRON_IPC.tabsClose, id),
    navigate: (id, url) =>
      ipcRenderer.invoke(ELECTRON_IPC.tabsNavigate, id, url),
    back: (id) => ipcRenderer.invoke(ELECTRON_IPC.tabsBack, id),
    forward: (id) => ipcRenderer.invoke(ELECTRON_IPC.tabsForward, id),
    reload: (id) => ipcRenderer.invoke(ELECTRON_IPC.tabsReload, id),
    stop: (id) => ipcRenderer.invoke(ELECTRON_IPC.tabsStop, id),
    duplicate: (id) => ipcRenderer.invoke(ELECTRON_IPC.tabsDuplicate, id),
    reorder: (id, beforeId) =>
      ipcRenderer.invoke(ELECTRON_IPC.tabsReorder, id, beforeId),
    moveHere: (id, beforeId) =>
      ipcRenderer.invoke(ELECTRON_IPC.tabsMoveHere, id, beforeId),
    detach: (id, point?: ElectronPoint) =>
      ipcRenderer.invoke(ELECTRON_IPC.tabsDetach, id, point),
    toggleMuted: (id) =>
      ipcRenderer.invoke(ELECTRON_IPC.tabsToggleMuted, id),
    openDroppedUrls: (urls) =>
      ipcRenderer.invoke(ELECTRON_IPC.tabsOpenDroppedUrls, urls),
    showMenu: (id, point: ElectronPoint) =>
      ipcRenderer.invoke(ELECTRON_IPC.tabsShowMenu, id, point),
    setBounds: (bounds: ElectronRect) =>
      ipcRenderer.invoke(ELECTRON_IPC.tabsSetBounds, bounds),
    onChanged(handler: (tabs: ElectronTabState[]) => void) {
      const listener = (_event: Electron.IpcRendererEvent, tabs: ElectronTabState[]) =>
        handler(tabs)
      ipcRenderer.on(ELECTRON_IPC.tabsChanged, listener)
      return () => ipcRenderer.removeListener(ELECTRON_IPC.tabsChanged, listener)
    }
  },
  window: {
    setFullscreen: (fullscreen) =>
      ipcRenderer.invoke(ELECTRON_IPC.windowSetFullscreen, fullscreen),
    setRedirects: (redirects: ElectronRedirectRule[]) =>
      ipcRenderer.invoke(ELECTRON_IPC.windowSetRedirects, redirects),
    setBackgroundColor: (color) =>
      ipcRenderer.invoke(ELECTRON_IPC.windowSetBackgroundColor, color),
    onTargetUrlChanged(handler: (url: string) => void) {
      const listener = (_event: Electron.IpcRendererEvent, url: string) =>
        handler(url)
      ipcRenderer.on(ELECTRON_IPC.windowTargetUrlChanged, listener)
      return () =>
        ipcRenderer.removeListener(ELECTRON_IPC.windowTargetUrlChanged, listener)
    },
    onFullscreenChanged(handler: (fullscreen: boolean) => void) {
      const listener = (
        _event: Electron.IpcRendererEvent,
        fullscreen: boolean
      ) => handler(fullscreen)
      ipcRenderer.on(ELECTRON_IPC.windowFullscreenChanged, listener)
      return () =>
        ipcRenderer.removeListener(ELECTRON_IPC.windowFullscreenChanged, listener)
    }
  }
}

contextBridge.exposeInMainWorld("onceElectron", bridge)
