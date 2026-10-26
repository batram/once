import { historyQuery, historyUrl, type BrowserHistoryPort, type BrowserVisit, type HistoryPage, type HistoryQuery } from "@once/core/browserHistory"

export interface HistoryStatement { sql: string; params?: Array<string | number> }
/** A dedicated history database. Batches are atomic and run off the UI thread. */
export interface HistorySqlDriver {
  batch(statements: HistoryStatement[]): Promise<void>
  query(statement: HistoryStatement): Promise<Array<Record<string, unknown>>>
}

// `seq` aliases the rowid so the FTS index keys on a stable value: an implicit
// rowid may be renumbered by VACUUM, which would silently desync the index.
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS visits (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, url TEXT NOT NULL, title TEXT NOT NULL, visitedAt INTEGER NOT NULL, searchText TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS visits_time ON visits(visitedAt DESC, id DESC)",
  "CREATE VIRTUAL TABLE IF NOT EXISTS visit_search USING fts5(title, url, content='visits', content_rowid='seq', tokenize='trigram')",
  "CREATE TRIGGER IF NOT EXISTS visits_insert AFTER INSERT ON visits BEGIN INSERT INTO visit_search(rowid,title,url) VALUES(new.seq,new.title,new.url); END",
  "CREATE TRIGGER IF NOT EXISTS visits_delete AFTER DELETE ON visits BEGIN INSERT INTO visit_search(visit_search,rowid,title,url) VALUES('delete',old.seq,old.title,old.url); END",
  "CREATE TRIGGER IF NOT EXISTS visits_update AFTER UPDATE ON visits BEGIN INSERT INTO visit_search(visit_search,rowid,title,url) VALUES('delete',old.seq,old.title,old.url); INSERT INTO visit_search(rowid,title,url) VALUES(new.seq,new.title,new.url); END"
]
const DROP_SEARCH = [
  ...["visits_insert", "visits_update", "visits_delete"].map(name => ({ sql: `DROP TRIGGER IF EXISTS ${name}` })),
  { sql: "DROP TABLE IF EXISTS visit_search" }
]

export class SqlBrowserHistory implements BrowserHistoryPort {
  private pending: Promise<unknown>
  constructor(private readonly driver: HistorySqlDriver) {
    this.pending = this.open()
  }

  /** Creates the schema, first moving a table from before `seq` existed over to it. */
  private async open(): Promise<void> {
    const [table] = await this.driver.query({ sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='visits'" })
    const legacy = typeof table?.sql === "string" && !/\bseq INTEGER PRIMARY KEY\b/.test(table.sql)
    await this.driver.batch([
      ...(legacy ? [...DROP_SEARCH, { sql: "ALTER TABLE visits RENAME TO visits_legacy" }, { sql: "DROP INDEX IF EXISTS visits_time" }] : []),
      ...SCHEMA.map(sql => ({ sql })),
      ...(legacy ? [
        { sql: "INSERT INTO visits(id,url,title,visitedAt,searchText) SELECT id,url,title,visitedAt,searchText FROM visits_legacy ORDER BY visitedAt,id" },
        { sql: "DROP TABLE visits_legacy" }
      ] : [])
    ])
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
      clauses.push("seq IN (SELECT rowid FROM visit_search WHERE visit_search MATCH ?)")
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
      ...DROP_SEARCH, { sql: "DELETE FROM visits" },
      ...SCHEMA.map(sql => ({ sql }))
    ]))
  }
}
