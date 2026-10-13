import { contextBridge, ipcRenderer } from "electron"
import { BrowserMenuBridge } from "./browserMenuTypes"

const bridge: BrowserMenuBridge = {
  state: () => ipcRenderer.invoke("browser-menu:state"),
  action: (action) => ipcRenderer.invoke("browser-menu:action", action),
  send: (deviceId) => ipcRenderer.invoke("browser-menu:send", deviceId),
  openDevices: (row, focus) => ipcRenderer.invoke("browser-menu:open-devices", row, focus),
  closeDevices: () => ipcRenderer.invoke("browser-menu:close-devices"),
  onDevicesClosed: (handler) => {
    ipcRenderer.on("browser-menu:devices-closed", () => handler())
  },
  ready: (height) => ipcRenderer.invoke("browser-menu:ready", height),
  onStateChanged: (handler) => {
    ipcRenderer.on("browser-menu:state-changed", (_event, state) => handler(state))
  }
}
contextBridge.exposeInMainWorld("onceBrowserMenu", bridge)
