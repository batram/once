const express = require("express")
const expressPouchDB = require("../helpers/couch-server")
const fs = require("fs")
const path = require("path")
const PouchDB = require("pouchdb")
const storyFixture = require("../e2e/shared/story-fixture")
const addonFixture = require("../e2e/shared/addon-fixture")

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
  if (!require("../e2e/shared/ai-addon-fixture").handleRequest(request, response)) next()
})

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
// The fixture Once add-on's script and the feed its collector reads.
app.get("/fixtures/addon/main.js", (_request, response) => {
  response.type("text/javascript").send(addonFixture.ADDON_SCRIPT)
})
app.get("/fixtures/api/stories.json", (request, response) => {
  const baseUrl = `${request.protocol}://${request.get("host")}`
  response.json(addonFixture.addonApiStories(baseUrl))
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
app.get("/fixtures/mobile-filter-list.txt", (_request, response) => {
  response.type("text/plain").send([
    // Synced mobile lists use the portable subset: resource options such as
    // $image are skipped, and a leading slash is reserved for unsupported regex rules.
    "*/fixtures/blocked-ad.png|",
    "##.once-filter-hide"
  ].join("\n"))
})
app.get("/fixtures/blocked-ad.png", (_request, response) => {
  response.type("image/png").send(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  ))
})
// Once Lite extension fixtures (tests/e2e/mobile/mobile.lite-extensions.js).
// Nothing on a device can resolve an ad host, so every probe lives on this
// server and uBlock gets its rules through a synced custom filter list. The
// list is generated per request so its hostname-scoped rules (cosmetic,
// scriptlet, HTML) name the host the device reaches this server through
// (10.0.2.2 on the emulator, 127.0.0.1 on the iOS simulator).
app.get("/fixtures/lite-filter-list.txt", (request, response) => {
  const host = request.hostname
  response.type("text/plain").send([
    `! Once Lite e2e fixture list for ${host}`,
    // Network: the ad script, by path so the port does not matter.
    "*/fixtures/ublock/ad.js$script",
    // Cosmetic: hide every ad slot on the fixture host.
    `${host}##.lite-ad-slot`,
    // Scriptlet: set-constant must run before the page's own inline script.
    `${host}##+js(set, liteAdsEnabled, false)`,
    // HTML filter: needs response-body filtering (filterResponseData).
    `${host}##^#lite-html-filtered`,
    // The smoke suite's article probes, so one list serves both specs.
    "*/fixtures/blocked-ad.png|",
    "##.once-filter-hide"
  ].join("\n"))
})
app.get("/fixtures/ublock/ad.js", (_request, response) => {
  response.type("text/javascript").send(
    "document.documentElement.dataset.adScript = \"ran\";\n"
  )
})
// The three uBlock probe pages share one body; they differ in how the CSP
// arrives: none, a strict header (nonce-only script-src, so the scriptlet
// has to go through the per-document nonce Lite adds), or the same policy in
// a <meta> tag (no header to amend, so scriptlets go through main-world
// evaluation). The page's own scripts carry the fixture nonce so the CSP
// itself blocks nothing; only uBlock can.
function ublockProbePage(title) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
    // First script in the document: if a scriptlet ran before it, the
    // constant is already pinned and this assignment is ignored.
    "<script nonce=\"fixture\">window.liteAdsEnabled = true;" +
    "document.documentElement.dataset.adsEnabledAtTop = String(window.liteAdsEnabled);</script>" +
    "</head><body>" +
    `<h1>${title}</h1>` +
    "<div class=\"lite-ad-slot\" id=\"lite-ad-slot-1\">ad slot one</div>" +
    "<div class=\"lite-ad-slot\" id=\"lite-ad-slot-2\">ad slot two</div>" +
    "<div id=\"lite-html-filtered\">html filter probe</div>" +
    "<p id=\"lite-content\">Once Lite extension probe content.</p>" +
    "<script nonce=\"fixture\" src=\"/fixtures/ublock/ad.js\" " +
    "onload=\"document.documentElement.dataset.adScript = document.documentElement.dataset.adScript || 'loaded'\" " +
    "onerror=\"document.documentElement.dataset.adScript = 'blocked'\"></script>" +
    "<script nonce=\"fixture\">window.addEventListener('load', () => {" +
    "const root = document.documentElement;" +
    // Under a strict policy the inline onload/onerror attributes above never
    // run; ad.js marks itself 'ran' when it loads, so the load listener settles it.
    "root.dataset.adScript = root.dataset.adScript === 'ran' ? 'loaded' : (root.dataset.adScript || 'blocked');" +
    "root.dataset.adsEnabled = String(window.liteAdsEnabled);" +
    "root.dataset.slotDisplay = getComputedStyle(document.querySelector('.lite-ad-slot')).display;" +
    "root.dataset.htmlFiltered = document.querySelector('#lite-html-filtered') ? 'present' : 'removed';" +
    "root.dataset.probeLoaded = 'true';" +
    "});</script>" +
    "</body></html>"
}
const STRICT_CSP = "script-src 'nonce-fixture'; object-src 'none'; base-uri 'none'"
app.get("/fixtures/ublock/page.html", (_request, response) => {
  response.type("text/html").send(ublockProbePage("uBlock probe"))
})
app.get("/fixtures/ublock/strict-csp.html", (_request, response) => {
  response.set("Content-Security-Policy", STRICT_CSP)
  response.type("text/html").send(ublockProbePage("uBlock probe under a strict CSP header"))
})
app.get("/fixtures/ublock/meta-csp.html", (_request, response) => {
  response.type("text/html").send(ublockProbePage("uBlock probe under a meta CSP")
    .replace("<meta charset=\"utf-8\">", `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${STRICT_CSP}">`))
})
// A page that makes several blockable requests, so uBlock's popup has a
// hostname and a blocked count above zero to show.
app.get("/fixtures/popup-probe.html", (_request, response) => {
  response.type("text/html").send(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Popup probe</title></head><body>" +
    "<h1 id=\"lite-popup-probe\">Popup probe</h1>" +
    "<img src=\"/fixtures/blocked-ad.png?n=1\" alt=\"\"><img src=\"/fixtures/blocked-ad.png?n=2\" alt=\"\">" +
    "<script src=\"/fixtures/ublock/ad.js?n=1\"></script><script src=\"/fixtures/ublock/ad.js?n=2\"></script>" +
    "<script src=\"/fixtures/ublock/ad.js?n=3\"></script>" +
    "<script>window.addEventListener('load', () => { document.documentElement.dataset.probeLoaded = 'true' })</script>" +
    "</body></html>"
  )
})
// Violentmonkey probes: the page defines globals a userscript may only reach
// through unsafeWindow (content injection) or directly (page injection), an
// element for GM_addStyle, and a same-server JSON for GM_xmlhttpRequest.
app.get("/fixtures/violentmonkey/page.html", (_request, response) => {
  response.type("text/html").send(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Violentmonkey probe</title>" +
    "<script>window.pageSecret = 'page-secret'; window.pageCounter = 1;</script>" +
    "</head><body>" +
    "<h1>Violentmonkey probe</h1>" +
    "<div id=\"vm-styled\">GM_addStyle hides me</div>" +
    "<div id=\"vm-target\">userscript target</div>" +
    "<script>window.addEventListener('load', () => { document.documentElement.dataset.probeLoaded = 'true' })</script>" +
    "</body></html>"
  )
})
app.get("/fixtures/violentmonkey/api.json", (_request, response) => {
  response.json({ token: "vm-api-ok" })
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
    `<article><h1>${title}</h1><p>${paragraph.repeat(8)}</p>` +
    "<div class=\"once-filter-hide\">filter probe</div>" +
    "<div id=\"once-userscript-target\">userscript probe</div>" +
    "<img id=\"once-ad-probe\" src=\"/fixtures/blocked-ad.png\" " +
    "onload=\"this.dataset.result=&quot;loaded&quot;\" " +
    "onerror=\"this.dataset.result=&quot;blocked&quot;\">" +
    "</article></body></html>"
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
