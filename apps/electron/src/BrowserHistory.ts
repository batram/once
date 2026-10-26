import { app, webContents } from "electron"
import { HISTORY_URL } from "@once/platform-electron/bridge"
import path from "node:path"
import { Worker } from "node:worker_threads"
import type { BrowserHistoryPort, HistoryPage } from "@once/core"

/** How long a crashed worker stays down before the next request starts another. */
const RESTART_DELAY = 30_000

let store: BrowserHistoryPort | undefined
export function browserHistory(): BrowserHistoryPort {
  if (store) return store
  const databasePath = path.join(app.getPath("userData"), "browser-history.sqlite")
  let worker: Worker | undefined
  let sequence = 0
  let failure: Error | undefined
  let retryAt = 0
  let quitting = false
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const fail = (error: Error) => {
    failure = error
    retryAt = Date.now() + RESTART_DELAY
    worker = undefined
    for (const task of pending.values()) task.reject(error)
    pending.clear()
  }
  // One bad start (a locked or corrupt file) must not switch history off for the
  // whole session: the next request after a pause spawns a fresh worker.
  const start = (): Worker => {
    const started = new Worker(path.join(__dirname, "history-worker.js"), { workerData: { path: databasePath } })
    started.on("message", ({ requestId, result, error }) => {
      const task = pending.get(requestId)
      pending.delete(requestId)
      if (error) task?.reject(new Error(error))
      else task?.resolve(result)
    })
    started.on("error", error => { if (worker === started) fail(error instanceof Error ? error : new Error(String(error))) })
    started.on("exit", () => { if (worker === started) fail(new Error("History worker stopped")) })
    failure = undefined
    return started
  }
  app.once("will-quit", () => { quitting = true; void worker?.terminate() })
  const request = (action: string, value?: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (quitting || (!worker && failure && Date.now() < retryAt)) { reject(failure ?? new Error("History is shutting down")); return }
    worker ??= start()
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
