import { contextBridge, ipcRenderer } from "electron"
import type { ImageTextViewBridge, ImageTextViewMessage } from "@once/ui-web/imageText/imageTextTypes"

// The image text overlay's own views relay to the main process only.
const bridge: ImageTextViewBridge = {
  send: (event) => ipcRenderer.send("image-text-overlay:event", event),
  onMessage: (handler) => {
    ipcRenderer.on("image-text-overlay:message", (_event, message: ImageTextViewMessage) => handler(message))
  }
}
contextBridge.exposeInMainWorld("onceImageTextOverlay", bridge)
