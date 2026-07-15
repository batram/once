const express = require("express")
const expressPouchDB = require("express-pouchdb")
const fs = require("fs")
const path = require("path")
const PouchDB = require("pouchdb")

const port = Number.parseInt(process.env.ONCE_MOBILE_TEST_PORT || "3211", 10)
const root = path.resolve(__dirname, "../..")
const databaseRoot = path.join(root, "test-results", "mobile", "pouchdb")
fs.mkdirSync(databaseRoot, { recursive: true })
const TestPouchDB = PouchDB.defaults({ prefix: `${databaseRoot}${path.sep}` })
const app = express()

app.use((request, response, next) => {
  const started = Date.now()
  response.on("finish", () => {
    console.log(`${request.method} ${request.originalUrl} ${response.statusCode} ${Date.now() - started}ms`)
  })
  next()
})

app.get("/health", (_request, response) => response.json({ ok: true }))
app.get("/test/urls", (_request, response) => response.json({
  android: `http://10.0.2.2:${port}`,
  ios: `http://127.0.0.1:${port}`
}))
app.use("/test/databases", express.json())
app.post("/test/databases/:name/reset", async (request, response, next) => {
  const name = request.params.name
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    response.status(400).json({ error: "invalid_test_database" })
    return
  }
  try {
    try {
      await new TestPouchDB(name).destroy()
    } catch (error) {
      if (error.status !== 404) throw error
    }
    const docs = Array.isArray(request.body?.docs) ? request.body.docs : []
    if (docs.length) await new TestPouchDB(name).bulkDocs(docs)
    response.json({ ok: true, database: name, seeded: docs.length })
  } catch (error) {
    next(error)
  }
})
app.use("/app", express.static(path.join(root, "apps", "mobile", "dist")))
app.get("/fixtures/feed.rss", (request, response) => {
  const baseUrl = `${request.protocol}://${request.get("host")}`
  response.type("application/rss+xml")
  response.send(`<?xml version="1.0" encoding="UTF-8" ?>
    <rss version="2.0"><channel><title>Once mobile fixtures</title>
    <link>${baseUrl}/fixtures/</link><description>Deterministic offline fixture</description>
    <item><title>Fixture article</title><link>${baseUrl}/fixtures/article.html</link>
    <guid>${baseUrl}/fixtures/article.html</guid><pubDate>Mon, 15 Jul 2030 10:00:00 GMT</pubDate></item>
    </channel></rss>`)
})
app.get("/fixtures/article.html", (_request, response) => {
  const paragraph =
    "Once mobile reader fixture content is intentionally detailed, deterministic, and long enough for article extraction. " +
    "It verifies that the sanitized in-app reader can preserve useful prose while discarding page chrome and scripts. "
  response.type("text/html").send(
    "<!doctype html><html><head><title>Fixture article</title></head><body>" +
    `<article><h1>Fixture article</h1><p>${paragraph.repeat(8)}</p></article></body></html>`
  )
})

app.use("/db", (request, response, next) => {
  const expected = `Basic ${Buffer.from("once-test:once-test").toString("base64")}`
  if (request.headers.authorization !== expected) {
    response.set("WWW-Authenticate", 'Basic realm="Once mobile test"')
    response.status(401).json({ error: "unauthorized", reason: "test credentials required" })
    return
  }
  next()
})
app.use("/db", expressPouchDB(TestPouchDB, { mode: "minimumForPouchDB" }))

app.listen(port, "0.0.0.0", () => {
  console.log(`Once mobile test environment listening on ${port}`)
})
