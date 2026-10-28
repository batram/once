import { contextBridge, ipcRenderer } from "electron"
import type { ReaderAiRequest, ReaderAiResponse } from "@once/core"
import { READER_TTS_IPC } from "./browser/readerTtsIpc"

// Registered with the session preload; expose narrow bridges only on reader documents.
if (typeof location !== "undefined" && location.protocol === "once-reader:" && location.host !== "runtime" && window.top === window) {
  contextBridge.exposeInMainWorld("onceReaderAi", {
    send: (request: ReaderAiRequest) => ipcRenderer.send("once:reader-ai-request", request),
    listen: (handler: (response: ReaderAiResponse) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, response: ReaderAiResponse) => handler(response)
      ipcRenderer.on("once:reader-ai-response", listener)
      return () => ipcRenderer.removeListener("once:reader-ai-response", listener)
    }
  })
  // Every reader document is an origin of its own, so the speech settings
  // and who is reading aloud are kept by main rather than by the origin.
  contextBridge.exposeInMainWorld("onceReaderTts", {
    getPreferences: () => ipcRenderer.invoke(READER_TTS_IPC.get),
    setPreferences: (preferences: unknown) => ipcRenderer.send(READER_TTS_IPC.set, preferences),
    claim: () => ipcRenderer.send(READER_TTS_IPC.claim),
    release: () => ipcRenderer.send(READER_TTS_IPC.release),
    onStop: (handler: () => void) => {
      const listener = () => handler()
      ipcRenderer.on(READER_TTS_IPC.stop, listener)
      return () => ipcRenderer.removeListener(READER_TTS_IPC.stop, listener)
    }
  })
}
