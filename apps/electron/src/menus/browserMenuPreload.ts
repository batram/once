import { contextBridge, ipcRenderer } from "electron"
import { BrowserMenuBridge } from "./browserMenuTypes"

const bridge: BrowserMenuBridge = {
  state: () => ipcRenderer.invoke("browser-menu:state"),
  action: (action) => ipcRenderer.invoke("browser-menu:action", action),
  ready: (height) => ipcRenderer.invoke("browser-menu:ready", height),
  onStateChanged: (handler) => {
    ipcRenderer.on("browser-menu:state-changed", (_event, state) => handler(state))
  }
}
contextBridge.exposeInMainWorld("onceBrowserMenu", bridge)
