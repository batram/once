// Preload of the tabs page, a tab in the browser session. Its only bridge
// asks the window's shell for the view, hears it change, and sends the
// reader's choices back. It exposes nothing outside the page's own scheme,
// and main checks every sender again.
import { contextBridge, ipcRenderer } from "electron"
import { ELECTRON_IPC, ElectronRemoteTabsPageBridge } from "@once/platform-electron/bridge"

if (location.protocol === "once-tabs:" && location.host === "view") {
  const bridge: ElectronRemoteTabsPageBridge = {
    connect: () => ipcRenderer.invoke(ELECTRON_IPC.remoteTabsConnect),
    onState(handler) {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown) => handler(state)
      ipcRenderer.on(ELECTRON_IPC.remoteTabsState, listener)
      return () => ipcRenderer.removeListener(ELECTRON_IPC.remoteTabsState, listener)
    },
    send: (command) => ipcRenderer.send(ELECTRON_IPC.remoteTabsCommand, command)
  }
  contextBridge.exposeInMainWorld("onceRemoteTabs", bridge)
}
