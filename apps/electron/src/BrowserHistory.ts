import { app, webContents } from "electron"
import { HISTORY_URL } from "@once/platform-electron/bridge"
import path from "node:path"
import { Worker } from "node:worker_threads"
import type { BrowserHistoryPort, HistoryPage } from "@once/core"

let store: BrowserHistoryPort | undefined
export function browserHistory(): BrowserHistoryPort {
  if (store) return store
  const worker = new Worker(path.join(__dirname, "history-worker.js"), { workerData: { path: path.join(app.getPath("userData"), "browser-history.sqlite") } })
  let sequence = 0
  let failure: Error | undefined
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const fail = (error: Error) => { failure = error; for (const task of pending.values()) task.reject(error); pending.clear() }
  worker.on("message", ({ requestId, result, error }) => {
    const task = pending.get(requestId)
    pending.delete(requestId)
    if (error) task?.reject(new Error(error))
    else task?.resolve(result)
  })
  worker.on("error", fail)
  worker.on("exit", () => fail(new Error("History worker stopped")))
  app.once("will-quit", () => void worker.terminate())
  const request = (action: string, value?: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return }
    const requestId = ++sequence
    pending.set(requestId, { resolve, reject })
    worker.postMessage({ requestId, action, value })
  })
  let changeTimer: ReturnType<typeof setTimeout> | undefined
  const write = async (action: string, value?: unknown): Promise<void> => {
    await request(action, value)
    if (changeTimer) return
    // A batch of background tabs completing together needs one list refresh.
    changeTimer = setTimeout(() => {
      changeTimer = undefined
      for (const page of webContents.getAllWebContents()) {
        if (!page.isDestroyed() && page.getURL() === HISTORY_URL) page.send("once:history:changed")
      }
    }, 50)
  }
  store = {
    record: value => write("record", value),
    updateTitle: (id, title) => write("updateTitle", { id, title }),
    query: async value => await request("query", value) as HistoryPage,
    remove: value => write("remove", value),
    clear: () => write("clear")
  }
  return store
}
