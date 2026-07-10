import { contextBridge, ipcRenderer } from "electron"
import {
  ELECTRON_IPC,
  ElectronBridge,
  ElectronFetchRequest,
  ElectronRect,
  ElectronTabState
} from "@once/platform-electron/bridge"

const bridge: ElectronBridge = {
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
    setBounds: (bounds: ElectronRect) =>
      ipcRenderer.invoke(ELECTRON_IPC.tabsSetBounds, bounds),
    onChanged(handler: (tabs: ElectronTabState[]) => void) {
      const listener = (_event: Electron.IpcRendererEvent, tabs: ElectronTabState[]) =>
        handler(tabs)
      ipcRenderer.on(ELECTRON_IPC.tabsChanged, listener)
      return () => ipcRenderer.removeListener(ELECTRON_IPC.tabsChanged, listener)
    }
  }
}

contextBridge.exposeInMainWorld("onceElectron", bridge)
