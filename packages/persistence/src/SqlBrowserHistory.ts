import { historyQuery, historyUrl, type BrowserHistoryPort, type BrowserVisit, type HistoryPage, type HistoryQuery } from "@once/core/browserHistory"

export interface HistoryStatement { sql: string; params?: Array<string | number> }
/** A dedicated history database. Batches are atomic and run off the UI thread. */
export interface HistorySqlDriver {
  batch(statements: HistoryStatement[]): Promise<void>
  query(statement: HistoryStatement): Promise<Array<Record<string, unknown>>>
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS visits (id TEXT NOT NULL UNIQUE, url TEXT NOT NULL, title TEXT NOT NULL, visitedAt INTEGER NOT NULL, searchText TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS visits_time ON visits(visitedAt DESC, id DESC)",
  "CREATE VIRTUAL TABLE IF NOT EXISTS visit_search USING fts5(title, url, content='visits', content_rowid='rowid', tokenize='trigram')",
  "CREATE TRIGGER IF NOT EXISTS visits_insert AFTER INSERT ON visits BEGIN INSERT INTO visit_search(rowid,title,url) VALUES(new.rowid,new.title,new.url); END",
  "CREATE TRIGGER IF NOT EXISTS visits_delete AFTER DELETE ON visits BEGIN INSERT INTO visit_search(visit_search,rowid,title,url) VALUES('delete',old.rowid,old.title,old.url); END",
  "CREATE TRIGGER IF NOT EXISTS visits_update AFTER UPDATE ON visits BEGIN INSERT INTO visit_search(visit_search,rowid,title,url) VALUES('delete',old.rowid,old.title,old.url); INSERT INTO visit_search(rowid,title,url) VALUES(new.rowid,new.title,new.url); END"
]

export class SqlBrowserHistory implements BrowserHistoryPort {
  private pending: Promise<unknown>
  constructor(private readonly driver: HistorySqlDriver) {
    this.pending = driver.batch(SCHEMA.map(sql => ({ sql })))
  }

  private ordered<T>(run: () => Promise<T>): Promise<T> {
    const result = this.pending.then(run)
    // A failed write must be reported but must not poison subsequent operations.
    this.pending = result.catch(() => undefined)
    return result
  }

  record(visit: BrowserVisit): Promise<void> {
    const url = historyUrl(visit.url)
    if (!url || !Number.isSafeInteger(visit.visitedAt) || !visit.id || visit.id.length > 100) return Promise.resolve()
    return this.ordered(() => this.driver.batch([{ sql: "INSERT OR IGNORE INTO visits(id,url,title,visitedAt,searchText) VALUES(?,?,?,?,?)",
      params: [visit.id, url, visit.title.slice(0, 2048), visit.visitedAt, `${visit.title.slice(0, 2048)} ${url}`.toLowerCase()] }]))
  }

  updateTitle(id: string, title: string): Promise<void> {
    return this.ordered(() => this.driver.batch([{ sql: "UPDATE visits SET title=?,searchText=? || ' ' || lower(url) WHERE id=? AND title<>?", params: [title.slice(0, 2048), title.slice(0, 2048).toLowerCase(), id, title.slice(0, 2048)] }]))
  }

  query(input: HistoryQuery): Promise<HistoryPage> {
    const { search, before, limit } = historyQuery(input)
    const clauses: string[] = []
    const params: Array<string | number> = []
    // Trigrams index literal substring searches, including URL punctuation. Short
    // queries use SQLite's scan; results and bridge payloads are always bounded.
    if ([...search].length >= 3) {
      clauses.push("rowid IN (SELECT rowid FROM visit_search WHERE visit_search MATCH ?)")
      params.push(`"${search.replaceAll('"', '""')}"`)
    } else if (search) {
      clauses.push("instr(searchText,?)>0")
      params.push(search.toLowerCase())
    }
    if (before) {
      clauses.push("(visitedAt,id)<(?,?)")
      params.push(before.visitedAt, before.id)
    }
    params.push(limit + 1)
    const sql = `SELECT id,url,title,visitedAt FROM visits${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY visitedAt DESC,id DESC LIMIT ?`
    return this.ordered(async () => {
      const rows = await this.driver.query({ sql, params })
      const entries = rows.slice(0, limit) as unknown as BrowserVisit[]
      const last = entries.at(-1)
      return { entries, ...(rows.length > limit && last ? { next: { visitedAt: last.visitedAt, id: last.id } } : {}) }
    })
  }

  remove(id: string): Promise<void> {
    return this.ordered(() => this.driver.batch([{ sql: "DELETE FROM visits WHERE id=?", params: [id] }]))
  }

  clear(): Promise<void> {
    return this.ordered(() => this.driver.batch([
      // Drop the search index atomically instead of generating one FTS tombstone
      // per visit. With the triggers absent SQLite can use its fast table clear.
      ...["visits_insert", "visits_update", "visits_delete"].map(name => ({ sql: `DROP TRIGGER ${name}` })),
      { sql: "DROP TABLE visit_search" }, { sql: "DELETE FROM visits" },
      ...SCHEMA.map(sql => ({ sql }))
    ]))
  }
}
