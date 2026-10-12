import { ipcMain } from "electron"
import { readReaderAiRequest, ReaderAiResponse } from "@once/core"
import { BrowserCoordinator } from "./TabManager"
import { sourceUrlFromReaderUrl } from "./browser/reader-url"

export function registerReaderAiRelay(coordinator: BrowserCoordinator): void {
  const documents = new Map<number, { id: string; seen: Set<string> }>()
  const revoked = new Set<string>()
  const watched = new WeakSet<Electron.WebContents>()
  const pending = new Map<string, { tab: Electron.WebContents; shell: Electron.WebContents; requestId: string; touch(): void; cleanup(): void }>()
  ipcMain.on("once:reader-ai-request", (event, raw: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame) return
    const source = sourceUrlFromReaderUrl(event.sender.getURL())
    if (!source) return
    try {
      const request = readReaderAiRequest(raw)
      if (new URL(source).href !== new URL(request.sourceUrl).href) return
      const shell = coordinator.shellOf(event.sender)
      if (!shell || shell.isDestroyed()) return
      const key = `${event.sender.id}:${request.id}`
      if (request.action === "cancel") { shell.send("once:reader-ai-host", key, request); pending.get(key)?.cleanup(); return }
      if (!request.documentId || revoked.has(request.documentId)) return
      const document = documents.get(event.sender.id)
      if (document && document.id !== request.documentId) return
      const current = document ?? { id: request.documentId, seen: new Set<string>() }
      if (current.seen.has(request.id) || current.seen.size >= 2000) return
      current.seen.add(request.id); documents.set(event.sender.id, current)
      if (!watched.has(event.sender)) {
        watched.add(event.sender)
        const invalidate = () => { const old = documents.get(event.sender.id); if (old) revoked.add(old.id); documents.delete(event.sender.id) }
        event.sender.on("did-start-navigation", invalidate)
        event.sender.once("destroyed", invalidate)
      }
      if ([...pending.values()].filter(item => item.tab === event.sender).length >= 2) return
      const tab = event.sender
      const closed = () => { if (!shell.isDestroyed()) shell.send("once:reader-ai-host", key, { ...request, action: "cancel" }); cleanup() }
      let timeout = setTimeout(closed, 150000)
      const touch = () => { clearTimeout(timeout); timeout = setTimeout(closed, 150000) }
      const cleanup = () => { clearTimeout(timeout); tab.removeListener("did-start-navigation", closed); tab.removeListener("destroyed", closed); shell.removeListener("destroyed", closed); pending.delete(key) }
      pending.set(key, { tab, shell, requestId: request.id, touch, cleanup })
      tab.once("did-start-navigation", closed); tab.once("destroyed", closed); shell.once("destroyed", closed)
      shell.send("once:reader-ai-host", key, request)
    } catch { /* Untrusted readers receive no access for invalid requests. */ }
  })
  ipcMain.on("once:reader-ai-reply", (event, key: string, response: ReaderAiResponse) => {
    const entry = pending.get(key)
    if (!entry || entry.shell !== event.sender || event.senderFrame !== event.sender.mainFrame) return
    if (!entry.tab.isDestroyed()) entry.tab.send("once:reader-ai-response", { ...response, id: entry.requestId })
    if (!response.progress) entry.cleanup()
    else entry.touch()
  })
}
