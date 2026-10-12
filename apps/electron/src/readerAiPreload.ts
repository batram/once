import { contextBridge, ipcRenderer } from "electron"
import type { ReaderAiRequest, ReaderAiResponse } from "@once/core"

// Registered with the session preload; expose a narrow bridge only on reader documents.
if (typeof location !== "undefined" && location.protocol === "once-reader:" && location.host !== "runtime" && window.top === window) {
  contextBridge.exposeInMainWorld("onceReaderAi", {
    send: (request: ReaderAiRequest) => ipcRenderer.send("once:reader-ai-request", request),
    listen: (handler: (response: ReaderAiResponse) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, response: ReaderAiResponse) => handler(response)
      ipcRenderer.on("once:reader-ai-response", listener)
      return () => ipcRenderer.removeListener("once:reader-ai-response", listener)
    }
  })
}
