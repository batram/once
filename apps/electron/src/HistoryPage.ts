import { ipcMain, net, type Session, type IpcMainInvokeEvent } from "electron"
import { HISTORY_URL } from "@once/platform-electron/bridge"
import { historyQuery, historyUrl, type HistoryQuery } from "@once/core"
import { browserHistory } from "./BrowserHistory"
import type { BrowserCoordinator } from "./TabManager"

export function isHistoryUrl(url: string): boolean { return url === HISTORY_URL }
export function configureHistoryProtocol(session: Session, entry: string): void {
  session.protocol.handle("once-history", request => {
    const url = new URL(request.url)
    if (url.host !== "view") return new Response("Not found", { status: 404 })
    if (/^\/(?:browser_history\/)?(index\.html|index\.js|index\.js\.map)$/.test(url.pathname)) {
      return net.fetch(new URL(`../browser_history/${url.pathname.split("/").pop()}`, entry).toString())
    }
    if (/^\/(css|imgs)\/[\w./-]+$/.test(url.pathname) && !url.pathname.includes("..")) {
      return net.fetch(new URL(`../main_window${url.pathname}`, entry).toString())
    }
    return new Response("Not found", { status: 404 })
  })
}
export function registerHistoryHandlers(coordinator: BrowserCoordinator): void {
  const page = (event: IpcMainInvokeEvent) => {
    if (!isHistoryUrl(event.sender.getURL()) || event.senderFrame !== event.sender.mainFrame) throw new Error("Untrusted history sender")
    const shell = coordinator.shellOf(event.sender)
    if (!shell) throw new Error("Untrusted history sender")
    const owner = coordinator.windowOf(shell)
    if (!owner) throw new Error("History window closed")
    return owner
  }
  ipcMain.handle("once:history:theme", event => {
    return page(event).backgroundColor
  })
  ipcMain.handle("once:history:query", (event, query: HistoryQuery) => { page(event); return browserHistory().query(historyQuery(query)) })
  ipcMain.handle("once:history:remove", async (event, id: unknown) => {
    page(event)
    if (typeof id !== "string" || id.length > 100) throw new Error("Invalid visit")
    await browserHistory().remove(id)
  })
  ipcMain.handle("once:history:clear", async event => { page(event); await browserHistory().clear() })
  ipcMain.handle("once:history:open", async (event, value: unknown) => {
    const owner = page(event)
    const url = typeof value === "string" && historyUrl(value)
    if (!url) throw new Error("Invalid history URL")
    await coordinator.createTab(owner, url, true)
  })
}
