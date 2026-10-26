import { parentPort, workerData } from "node:worker_threads"
import { DatabaseSync } from "node:sqlite"
import { SqlBrowserHistory } from "@once/persistence/SqlBrowserHistory"
import type { HistorySqlDriver } from "@once/persistence/SqlBrowserHistory"
import type { BrowserHistoryPort, HistoryQuery, BrowserVisit } from "@once/core"

if (!parentPort) throw new Error("History must run in its worker")
const port = parentPort
const database = new DatabaseSync(workerData.path)
database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON")
const driver: HistorySqlDriver = {
  async batch(statements) {
    database.exec("BEGIN IMMEDIATE")
    try {
      for (const { sql, params = [] } of statements) database.prepare(sql).run(...params)
      database.exec("COMMIT")
    } catch (error) { database.exec("ROLLBACK"); throw error }
    if (statements.some(({ sql }) => sql.startsWith("DELETE"))) database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  },
  async query({ sql, params = [] }) { return database.prepare(sql).all(...params) }
}
const history: BrowserHistoryPort = new SqlBrowserHistory(driver)
port.on("message", async ({ requestId, action, value }) => {
  try {
    let result: unknown
    switch (action) {
      case "record": result = await history.record(value as BrowserVisit); break
      case "updateTitle": result = await history.updateTitle(value.id, value.title); break
      case "query": result = await history.query(value as HistoryQuery); break
      case "remove": result = await history.remove(String(value)); break
      case "clear": result = await history.clear(); break
      default: throw new Error("Unknown history operation")
    }
    port.postMessage({ requestId, result })
  } catch { port.postMessage({ requestId, error: "History storage failed" }) }
})
