const { DatabaseSync } = require("node:sqlite")
const { performance } = require("node:perf_hooks")
const { SqlBrowserHistory } = require("../packages/persistence/dist/SqlBrowserHistory")

async function main() {
  const count = Number(process.argv[2] || 100000)
  const db = new DatabaseSync(":memory:")
  const store = new SqlBrowserHistory({
    async batch(statements) {
      db.exec("BEGIN")
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...params)
        db.exec("COMMIT")
      } catch (error) { db.exec("ROLLBACK"); throw error }
    },
    async query({ sql, params = [] }) { return db.prepare(sql).all(...params) }
  })
  await store.query({})
  const insert = db.prepare("INSERT INTO visits(id,url,title,visitedAt,searchText) VALUES(?,?,?,?,?)")
  db.exec("BEGIN")
  for (let index = 0; index < count; index++) {
    insert.run(String(index), `https://example.test/articles/${index}`, `${index % 1000 === 0 ? "Rare needle" : "Everyday article"} ${index}`, 1700000000000 + index, `${index % 1000 === 0 ? "Rare needle" : "Everyday article"} ${index} https://example.test/articles/${index}`.toLowerCase())
  }
  db.exec("COMMIT")
  const results = {}
  for (const [name, query] of Object.entries({ recent: {}, deepPage: { before: { visitedAt: 1700000000100, id: "100" } }, rareSearch: { search: "needle" }, commonSearch: { search: "article" }, shortSearch: { search: "zz" } })) {
    const timings = []
    for (let run = 0; run < 30; run++) {
      const start = performance.now()
      const page = await store.query(query)
      timings.push(performance.now() - start)
      if (page.entries.length > 50) throw new Error("Unbounded history result")
    }
    timings.sort((a, b) => a - b)
    results[name] = { medianMs: +timings[15].toFixed(2), p95Ms: +timings[28].toFixed(2) }
  }
  console.log(JSON.stringify({ visits: count, sqlite: db.prepare("SELECT sqlite_version() AS version").get().version, results }, null, 2))
  db.close()
}
main().catch(error => { console.error(error); process.exitCode = 1 })
