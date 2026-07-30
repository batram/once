const express = require("express")
const expressPouchDB = require("express-pouchdb")
const fs = require("fs")
const path = require("path")
const PouchDB = require("pouchdb")
const storyFixture = require("../e2e/shared/story-fixture")

const port = Number.parseInt(process.env.ONCE_MOBILE_TEST_PORT || "3211", 10)
const host = process.env.ONCE_MOBILE_TEST_HOST || "0.0.0.0"
const owner = process.env.ONCE_MOBILE_TEST_OWNER || ""
const root = process.env.ONCE_MOBILE_TEST_APP_ROOT
  ? path.resolve(process.env.ONCE_MOBILE_TEST_APP_ROOT)
  : path.resolve(__dirname, "../..")
const runIdentity = (owner || `pid-${process.pid}`).replace(/[^a-zA-Z0-9_-]/g, "_")
const configuredDataDirectory = process.env.ONCE_MOBILE_TEST_DATA_DIR
const resultDirectory = port === 3211 ? "mobile" :
  port === 0 ? `mobile-run-${runIdentity}` : `mobile-${port}`
const databaseRoot = configuredDataDirectory
  ? path.resolve(configuredDataDirectory)
  : path.join(root, "test-results", resultDirectory, "pouchdb")
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

app.get("/health", (_request, response) => response.json({
  ok: true,
  owner,
  pid: process.pid,
  port: response.socket.localPort
}))
app.get("/test/urls", (_request, response) => response.json({
  android: process.env.ONCE_MOBILE_TEST_URL || `http://10.0.2.2:${port}`,
  ios: `http://127.0.0.1:${port}`
}))
app.get("/fixtures/visual-feed.json", (request, response) => {
  const baseUrl = `${request.protocol}://${request.get("host")}`
  response.json(storyFixture.feedJson(baseUrl))
})
app.use((request, response, next) => {
  const baseUrl = `${request.protocol}://${request.get("host")}`
  if (!storyFixture.handleRequest(request, response, baseUrl)) next()
})
app.use("/test/databases", express.json())
app.post("/test/databases/:name/reset", async (request, response, next) => {
  const name = request.params.name
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    response.status(400).json({ error: "invalid_test_database" })
    return
  }
  try {
    const database = new TestPouchDB(name)
    const existing = await database.allDocs({ include_docs: true })
    const deletions = existing.rows
      .map(row => row.doc)
      .filter(Boolean)
      .map(doc => ({ _id: doc._id, _rev: doc._rev, _deleted: true }))
    if (deletions.length) {
      await database.bulkDocs(deletions)
    }
    const docs = Array.isArray(request.body?.docs) ? request.body.docs : []
    if (docs.length) await database.bulkDocs(docs)
    await database.close()
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
app.get("/fixtures/visual-feed.rss", (request, response) => {
  const baseUrl = `${request.protocol}://${request.get("host")}`
  const stories = [
    ["A careful look at native reading surfaces", "native-reading", "Mon, 15 Jul 2030 10:00:00 GMT"],
    ["Designing a calmer story list", "calmer-list", "Mon, 15 Jul 2030 09:00:00 GMT"],
    ["Why deterministic tests improve product work", "deterministic-tests", "Mon, 15 Jul 2030 08:00:00 GMT"],
    ["Small details in mobile typography", "typography", "Sun, 14 Jul 2030 18:00:00 GMT"],
    ["An unusually long headline for checking wrapping across narrow phone layouts", "long-headline", "Sun, 14 Jul 2030 15:00:00 GMT"],
    ["Offline-first interfaces in practice", "offline-first", "Sun, 14 Jul 2030 12:00:00 GMT"],
    ["Reader mode without the browser chrome", "reader-mode", "Sat, 13 Jul 2030 17:00:00 GMT"],
    ["A short title", "short-title", "Sat, 13 Jul 2030 11:00:00 GMT"]
  ]
  const items = stories.map(([title, slug, published]) => {
    const url = `${baseUrl}/fixtures/articles/${slug}.html`
    return `<item><title>${title}</title><link>${url}</link>` +
      `<guid>${url}</guid><pubDate>${published}</pubDate></item>`
  }).join("")
  response.type("application/rss+xml")
  response.send(`<?xml version="1.0" encoding="UTF-8" ?>
    <rss version="2.0"><channel><title>Once visual inspection</title>
    <link>${baseUrl}/fixtures/</link>
    <description>Varied deterministic stories for mobile visual inspection</description>
    ${items}</channel></rss>`)
})
app.get([
  "/fixtures/article.html",
  "/fixtures/articles/:slug.html"
], (request, response) => {
  const slug = request.params.slug || "fixture-article"
  const title = request.params.slug
    ? slug.split("-")
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
    : "Fixture article"
  const paragraph =
    "Once mobile reader fixture content is intentionally detailed, deterministic, and long enough for article extraction. " +
    "It verifies that the sanitized in-app reader can preserve useful prose while discarding page chrome and scripts. "
  response.type("text/html").send(
    `<!doctype html><html><head><title>${title}</title></head><body>` +
    `<article><h1>${title}</h1><p>${paragraph.repeat(8)}</p></article></body></html>`
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

const server = app.listen(port, host, () => {
  const address = server.address()
  const listeningPort = typeof address === "object" && address ? address.port : port
  console.log(`Once mobile test environment listening on ${listeningPort}`)
  process.send?.({ type: "once-mobile-test-server-ready", port: listeningPort, owner })
})
server.on("error", error => {
  const details = {
    code: error.code || "UNKNOWN",
    message: error.message,
    address: error.address || host,
    port: error.port ?? port
  }
  console.error(
    "Unable to start the mobile test environment on " +
    `${details.address}:${details.port} (${details.code}): ${details.message}`
  )
  const failure = {
    type: "once-mobile-test-server-failed",
    owner,
    error: details
  }
  if (process.send) {
    process.send(failure, () => process.exit(1))
  } else {
    process.exit(1)
  }
})

let closing = false
function close() {
  if (closing) return
  closing = true
  if (!server.listening) {
    process.exit(0)
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 2_000).unref()
}
process.on("SIGINT", close)
process.on("SIGTERM", close)
