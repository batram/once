const test = require("node:test")
const assert = require("node:assert/strict")
const { DatabaseSync } = require("node:sqlite")
const { SqlBrowserHistory } = require("../../../packages/persistence/dist/SqlBrowserHistory")
const { historyUrl } = require("../../../packages/core/dist/browserHistory")

function fixture() {
  const db = new DatabaseSync(":memory:")
  const driver = {
    async batch(statements) {
      db.exec("BEGIN")
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...params)
        db.exec("COMMIT")
      } catch (error) { db.exec("ROLLBACK"); throw error }
    },
    async query({ sql, params = [] }) { return db.prepare(sql).all(...params) }
  }
  return { db, driver, history: new SqlBrowserHistory(driver) }
}
const visit = (id, title = "Example", visitedAt = 1000) => ({ id, title, visitedAt, url: `https://example.com/${id}` })

test("history records only web URLs and strips credentials and fragments", async () => {
  const { db, history } = fixture()
  await history.record({ ...visit("one"), url: "https://alice:secret@example.com/page#section" })
  for (const url of ["about:blank", "file:///secret", "once-history://view/index.html", "javascript:alert(1)", "bad url"]) {
    await history.record({ ...visit(url), url })
    assert.equal(historyUrl(url), null)
  }
  assert.deepEqual((await history.query({})).entries.map(row => row.url), ["https://example.com/page"])
  db.close()
})

test("trigram search supports literal substrings, punctuation, quotes and Unicode", async () => {
  const { db, history } = fixture()
  await history.record(visit("alpha", 'München / A "quoted" title 100%'))
  await history.record(visit("beta", "Unrelated"))
  for (const search of ["nchen", "MÜN", "MÜ", "Ü", '"quoted"', "100%", "example.com/alpha", "A \"q"]) {
    assert.deepEqual((await history.query({ search })).entries.map(row => row.id), ["alpha"], search)
  }
  assert.equal((await history.query({ search: "zz" })).entries.length, 0)
  assert.equal((await history.query({ search: "%" })).entries.length, 1, "short searches are literal too")
  db.close()
})

test("history pagination is stable for equal timestamps and new visits", async () => {
  const { db, history } = fixture()
  for (let index = 0; index < 123; index++) await history.record(visit(String(index).padStart(3, "0")))
  let page = await history.query({ limit: 50 })
  assert.equal(page.entries.length, 50)
  const ids = page.entries.map(row => row.id)
  await history.record(visit("newest", "New visit", 2000))
  while (page.next) {
    page = await history.query({ before: page.next, limit: 50 })
    ids.push(...page.entries.map(row => row.id))
  }
  assert.equal(new Set(ids).size, 123)
  assert.equal(ids.includes("newest"), false)
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM visits WHERE (visitedAt,id)<(?,?) ORDER BY visitedAt DESC,id DESC LIMIT 51").all(1000, "070")
  assert.match(JSON.stringify(plan), /visits_time/)
  assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/)
  db.close()
})

test("deleting one visit updates search and late titles never resurrect it", async () => {
  const { db, history } = fixture()
  await history.record(visit("one", "Original title"))
  await history.record(visit("two", "Original title"))
  await history.updateTitle("one", "Updated title")
  assert.deepEqual((await history.query({ search: "Updated" })).entries.map(row => row.id), ["one"])
  await history.remove("one")
  await history.updateTitle("one", "Late title")
  assert.equal((await history.query({ search: "Updated" })).entries.length, 0)
  assert.deepEqual((await history.query({})).entries.map(row => row.id), ["two"])
  db.close()
})

test("queued visits are cleared atomically and the store can record again", async () => {
  const { db, history } = fixture()
  const first = history.record(visit("one"))
  const second = history.record(visit("two"))
  const clear = history.clear()
  await Promise.all([first, second, clear])
  assert.equal((await history.query({})).entries.length, 0)
  assert.equal((await history.query({ search: "Example" })).entries.length, 0)
  await history.record(visit("three"))
  assert.equal((await history.query({})).entries.length, 1)
  db.close()
})

test("a new repository reopens the existing history and clamps result limits", async () => {
  const { db, history, driver } = fixture()
  for (let index = 0; index < 105; index++) await history.record(visit(String(index)))
  const reopened = new SqlBrowserHistory(driver)
  assert.equal((await reopened.query({ limit: 999999 })).entries.length, 100)
  assert.equal((await reopened.query({ limit: -1 })).entries.length, 1)
  db.close()
})
