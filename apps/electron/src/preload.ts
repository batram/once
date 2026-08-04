import { contextBridge, ipcRenderer } from "electron"
import {
  ELECTRON_IPC,
  ElectronBridge,
  ElectronFetchRequest,
  ElectronFocusSurface,
  ElectronPoint,
  ElectronRect,
  ElectronRedirectRule,
  ElectronTabState,
  ElectronUpdateStatus
} from "@once/platform-electron/bridge"

const bridge: ElectronBridge = {
  app: {
    getBuildInfo: () => ipcRenderer.invoke(ELECTRON_IPC.appGetBuildInfo),
    getUpdateStatus: () => ipcRenderer.invoke(ELECTRON_IPC.appGetUpdateStatus),
    checkForUpdates: () => ipcRenderer.invoke(ELECTRON_IPC.appCheckForUpdates),
    onUpdateStatusChanged(handler: (status: ElectronUpdateStatus) => void) {
      const listener = (
        _event: Electron.IpcRendererEvent,
        status: ElectronUpdateStatus
      ) => handler(status)
      ipcRenderer.on(ELECTRON_IPC.appUpdateStatusChanged, listener)
      return () =>
        ipcRenderer.removeListener(ELECTRON_IPC.appUpdateStatusChanged, listener)
    }
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
    showReaderError: (sourceUrl, error) =>
      ipcRenderer.invoke(ELECTRON_IPC.tabsShowReaderError, sourceUrl, error),
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
    startSourcePicker: (url?: string) =>
      ipcRenderer.invoke(ELECTRON_IPC.tabsStartSourcePicker, url),
    showMenu: (id, point: ElectronPoint) =>
      ipcRenderer.invoke(ELECTRON_IPC.tabsShowMenu, id, point),
    setBounds: (bounds: ElectronRect) =>
      ipcRenderer.invoke(ELECTRON_IPC.tabsSetBounds, bounds),
    restoreClosed: () => ipcRenderer.invoke(ELECTRON_IPC.tabsRestoreClosed),
    focusContent: () => ipcRenderer.invoke(ELECTRON_IPC.tabsFocusContent),
    onChanged(handler: (tabs: ElectronTabState[]) => void) {
      const listener = (_event: Electron.IpcRendererEvent, tabs: ElectronTabState[]) =>
        handler(tabs)
      ipcRenderer.on(ELECTRON_IPC.tabsChanged, listener)
      return () => ipcRenderer.removeListener(ELECTRON_IPC.tabsChanged, listener)
    },
    onRegenerateReader(handler: (sourceUrl: string) => void) {
      const listener = (_event: Electron.IpcRendererEvent, sourceUrl: string) =>
        handler(sourceUrl)
      ipcRenderer.on(ELECTRON_IPC.tabsRegenerateReader, listener)
      return () =>
        ipcRenderer.removeListener(ELECTRON_IPC.tabsRegenerateReader, listener)
    }
  },
  storyMenu: {
    show: (items, point) =>
      ipcRenderer.invoke(ELECTRON_IPC.storyMenuShow, items, point),
    openExternal: (url) =>
      ipcRenderer.invoke(ELECTRON_IPC.storyMenuOpenExternal, url),
    openWindow: (url) =>
      ipcRenderer.invoke(ELECTRON_IPC.storyMenuOpenWindow, url)
  },
  window: {
    setFullscreen: (fullscreen) =>
      ipcRenderer.invoke(ELECTRON_IPC.windowSetFullscreen, fullscreen),
    create: () => ipcRenderer.invoke(ELECTRON_IPC.windowCreate),
    focusShell: () => ipcRenderer.invoke(ELECTRON_IPC.windowFocusShell),
    setForwardedKeys: (chords: string[]) =>
      ipcRenderer.invoke(ELECTRON_IPC.windowSetForwardedKeys, chords),
    onNativeFocusChanged(handler: (surface: ElectronFocusSurface) => void) {
      const listener = (
        _event: Electron.IpcRendererEvent,
        surface: ElectronFocusSurface
      ) => handler(surface)
      ipcRenderer.on(ELECTRON_IPC.windowNativeFocusChanged, listener)
      return () =>
        ipcRenderer.removeListener(ELECTRON_IPC.windowNativeFocusChanged, listener)
    },
    onKeyCommand(handler: (chord: string) => void) {
      const listener = (_event: Electron.IpcRendererEvent, chord: string) =>
        handler(chord)
      ipcRenderer.on(ELECTRON_IPC.windowKeyCommand, listener)
      return () => ipcRenderer.removeListener(ELECTRON_IPC.windowKeyCommand, listener)
    },
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
