import { contextBridge, ipcRenderer } from "electron"
import { ExtensionMenuBridge } from "./extensionMenuTypes"

const bridge: ExtensionMenuBridge = {
  state: () => ipcRenderer.invoke("extension-menu:state"),
  action: (action, host) => ipcRenderer.invoke("extension-menu:action", action, host)
}
contextBridge.exposeInMainWorld("onceExtensionMenu", bridge)
