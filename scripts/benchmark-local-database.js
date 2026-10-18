// Isolated IndexedDB benchmark; optional raw IDB snapshot stays on loopback.
// node scripts/run-hidden.js scripts/benchmark-local-database.js [snapshot.json] [output.json]
const fs = require("node:fs/promises")
const path = require("node:path")
const http = require("node:http")
const webpack = require("webpack")
const { chromium } = require("playwright")

async function main() {
  const output = path.resolve(process.argv[3] || "artifacts/performance/local-database.json")
  const directory = path.dirname(output)
  await fs.mkdir(directory, { recursive: true })
  await new Promise((resolve, reject) => webpack({ mode: "production", target: "web",
    entry: path.join(__dirname, "benchmark-local-database-entry.js"),
    output: { path: directory, filename: "local-database-benchmark.js" }, optimization: { minimize: false }
  }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve()))
  const snapshot = process.argv[2] ? await fs.readFile(process.argv[2]) : Buffer.from("null")
  const bundle = await fs.readFile(path.join(directory, "local-database-benchmark.js"))
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/snapshot" ? "application/json" : request.url === "/bundle.js" ? "text/javascript" : "text/html")
    response.end(request.url === "/snapshot" ? snapshot : request.url === "/bundle.js" ? bundle : '<script src="/bundle.js"></script>')
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch({ headless: true })
  const report = { at: new Date().toISOString(), browser: browser.version(), adapter: "PouchDB 9 IndexedDB",
    dataset: process.argv[2] ? "provided snapshot, isolated origin" : "33,000 synthetic stories", results: [] }
  const save = () => fs.writeFile(output, JSON.stringify(report, null, 2) + "\n")
  try {
    for (const mode of ["optimized", "stock"]) {
      const context = await browser.newContext()
      await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
      const page = await context.newPage()
      page.on("pageerror", error => console.error(error.message))
      await page.goto(origin)
      const info = await page.evaluate(async () => window.prepareDatabaseBenchmark(await (await fetch("/snapshot")).json()))
      console.log(JSON.stringify({ mode, documents: info.doc_count, prepared: true }))
      const timer = setInterval(async () => {
        try { console.log(JSON.stringify(await page.evaluate(() => window.databaseBenchmarkProgress))) } catch { /* page closed */ }
      }, 15000)
      try {
        const result = await page.evaluate(mode => window.benchmarkCompaction(mode), mode)
        report.results.push(result); await save(); console.log(JSON.stringify(result))
        if (mode === "optimized") {
          report.starred = await page.evaluate(() => window.benchmarkStarred())
          await save(); console.log(JSON.stringify(report.starred))
          report.writeLocks = await page.evaluate(() => window.benchmarkWriteLocks())
          await save(); console.log(JSON.stringify(report.writeLocks))
        }
      } finally { clearInterval(timer); await context.close() }
    }
  } finally { await browser.close(); server.close() }
  console.log(`Saved ${output}`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
