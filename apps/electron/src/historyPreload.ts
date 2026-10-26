import { contextBridge, ipcRenderer } from "electron"
import type { BrowserHistoryPort, HistoryQuery } from "@once/core"

export type HistoryPageBridge = Pick<BrowserHistoryPort, "query" | "remove" | "clear"> & { open(url: string): Promise<void>; theme(): Promise<string>; onChanged(handler: () => void): void; onTheme(handler: (color: string) => void): void }
const bridge: HistoryPageBridge = {
  onChanged: handler => { ipcRenderer.on("once:history:changed", () => handler()) },
  theme: () => ipcRenderer.invoke("once:history:theme"),
  onTheme: handler => { ipcRenderer.on("once:history:theme", (_event, color: string) => handler(color)) },
  query: (query: HistoryQuery) => ipcRenderer.invoke("once:history:query", query),
  remove: id => ipcRenderer.invoke("once:history:remove", id),
  clear: () => ipcRenderer.invoke("once:history:clear"),
  open: url => ipcRenderer.invoke("once:history:open", url)
}
contextBridge.exposeInMainWorld("onceHistory", bridge)
