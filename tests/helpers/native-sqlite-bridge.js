const { DatabaseSync } = require("node:sqlite")
const path = require("node:path")
const fs = require("node:fs")
const crypto = require("node:crypto")

/** Test transport; production Java implementation is separately exercised on Android. */
function sqliteBridge(directory) {
  const databases = new Map(), iterators = new Map()
  const file = name => path.join(directory, crypto.createHash("sha256").update(name).digest("hex") + ".sqlite")
  return {
    async execute(request) {
      const { operation, name } = request
      const db = databases.get(name)
      if (operation === "open") {
        const opened = new DatabaseSync(file(name))
        opened.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID")
        databases.set(name, opened)
      } else if (operation === "close" || operation === "destroy") {
        db?.close()
        databases.delete(name)
        if (operation === "destroy") fs.rmSync(file(name), { force: true })
      } else if (operation === "getMany") {
        return { values: request.keys.map(key => {
          const row = db.prepare("SELECT v FROM kv WHERE k=?").get(key)
          return row ? Buffer.from(row.v).toString("base64") : null
        }) }
      } else if (operation === "batch") {
        db.exec("BEGIN IMMEDIATE")
        try {
          for (const op of request.operations) {
            if (op.type === "put") db.prepare("INSERT OR REPLACE INTO kv VALUES(?,?)").run(op.key, Buffer.from(op.value, "base64"))
            else if (op.type === "del") db.prepare("DELETE FROM kv WHERE k=?").run(op.key)
            else throw new Error("Invalid operation")
          }
          db.exec("COMMIT")
        } catch (error) { db.exec("ROLLBACK"); throw error }
      } else if (operation === "iteratorOpen") {
        if (request.gte !== undefined && request.gte === request.lte && request.gt === undefined && request.lt === undefined) {
          const row = db.prepare("SELECT k,v FROM kv WHERE k=?").get(request.gte)
          return { iterator: null, done: true, rows: row && request.limit !== 0 ? [{ key: row.k, value: Buffer.from(row.v).toString("base64") }] : [] }
        }
        if (iterators.size >= 64) throw new Error("Too many open range snapshots")
        const conditions = [], parameters = []
        for (const [bound, operator] of [["gt", ">"], ["gte", ">="], ["lt", "<"], ["lte", "<="]]) {
          if (request[bound] !== undefined) { conditions.push(`k${operator}?`); parameters.push(request[bound]) }
        }
        const rows = db.prepare(`SELECT k,v FROM kv ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""} ORDER BY k ${request.reverse ? "DESC" : "ASC"} LIMIT ?`)
          .all(...parameters, request.limit ?? -1)
          .map(row => ({ key: row.k, value: Buffer.from(row.v).toString("base64") }))
        const iterator = crypto.randomUUID()
        iterators.set(iterator, rows)
        return { iterator }
      } else if (operation === "iteratorNext") {
        const remaining = iterators.get(request.iterator)
        return { rows: remaining.splice(0, 128), done: remaining.length === 0 }
      } else if (operation === "iteratorEnd") iterators.delete(request.iterator)
      else throw new Error("Unexpected operation " + operation)
      return {}
    }
  }
}
module.exports = { sqliteBridge }
