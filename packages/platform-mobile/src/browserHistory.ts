import { Capacitor, registerPlugin } from "@capacitor/core"
import { IndexedDbBrowserHistory, SqlBrowserHistory, type HistorySqlDriver } from "@once/persistence"
import type { BrowserHistoryPort } from "@once/core"

const NativeHistory = registerPlugin<{ execute(options: { statements?: unknown[]; statement?: unknown }): Promise<{ rows?: Array<Record<string, unknown>> }> }>("BrowserHistory")
let store: BrowserHistoryPort | undefined
export function mobileBrowserHistory(): BrowserHistoryPort {
  if (store) return store
  const driver: HistorySqlDriver = {
    batch: async statements => { await NativeHistory.execute({ statements }) },
    query: async statement => (await NativeHistory.execute({ statement })).rows ?? []
  }
  store = Capacitor.isNativePlatform() ? new SqlBrowserHistory(driver) : new IndexedDbBrowserHistory()
  return store
}
