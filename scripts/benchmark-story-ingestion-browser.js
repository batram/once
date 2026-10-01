// Run after npm run build:packages. Browser state and bundle are temporary.
const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const http = require("node:http")
const webpack = require("webpack")
const { chromium } = require("playwright")
const concurrencyExperiment = process.argv.includes("--concurrency")
const production = process.argv.includes("--production")
const output = path.resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] :
  production ? "docs/benchmarks/story-ingestion-production.json" :
    concurrencyExperiment ? "docs/benchmarks/story-ingestion-concurrency.json" : "docs/benchmarks/story-ingestion-indexeddb.json")
async function removeBenchmarkDirectory(directory) {
  const resolvedDirectory = path.resolve(directory)
  if (!resolvedDirectory.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(resolvedDirectory).startsWith("once-ingestion-browser-")) {
    throw new Error(`Refusing cleanup outside benchmark temporary directory: ${resolvedDirectory}`)
  }
  await fs.rm(resolvedDirectory, { recursive: true, force: true })
}
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-ingestion-browser-"))
  let browser, server
  try {
    await new Promise((resolve, reject) => webpack({ mode: "production", target: "web",
      entry: path.join(__dirname, "benchmark-story-ingestion-browser-entry.js"),
      output: { path: directory, filename: "benchmark.js" }, optimization: { minimize: false }
    }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve()))
    const bundle = await fs.readFile(path.join(directory, "benchmark.js"))
    server = http.createServer((request, response) => {
      response.setHeader("Content-Type", request.url === "/benchmark.js" ? "text/javascript" : "text/html")
      response.end(request.url === "/benchmark.js" ? bundle : '<!doctype html><title>Ingestion benchmark</title><script src="/benchmark.js"></script>')
    })
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    page.on("pageerror", error => console.error(error))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => typeof window.ingestionBenchmark === "function")
    const metadata = { date: new Date().toISOString(), browser: browser.version(), node: process.version,
      adapter: "PouchDB 9 browser IndexedDB with LOCAL_POUCH_OPTIONS; headless Chromium, not Electron",
      archiveStories: 10000, repetitions: production ? 3 : 5, sourceCounts: concurrencyExperiment || production ? [6] : [1, 6], batchSizes: production ? [100, 300, 1000] : [30, 100, 300, 1000],
      concurrencyLimits: production ? [64] : concurrencyExperiment ? [null, 16, 64, 256] : [null],
      production,
      gate: production ? "native AppRuntime gate after per-URL ordering; story-operation observation at addStoryNow" : "experimental FIFO gate around addStory; native gate bypassed; bulk lookups outside gate",
      timing: "processStoryInput including filters, bulk lookup, working-set merge, saves and events; excludes network, parsing, rendering, DB creation and seeding",
      phases: { cold: "new URLs in an open database with historical archive", warm: "same unchanged URLs and runtime", warmChanged: "one additional tag per story" } }
    const samples = []
    await fs.mkdir(path.dirname(output), { recursive: true })
    // Discard a small run to initialize modules/JIT and the adapter.
    await page.evaluate(options => window.ingestionBenchmark(options), { size: 30, sources: 1, repetition: -1, production, concurrency: production ? 64 : null })
    for (const size of metadata.batchSizes) for (const sources of metadata.sourceCounts) {
      for (let repetition = 0; repetition < metadata.repetitions; repetition++) {
        // Rotate strategy order to distribute JIT/cache/host-load effects.
        const limits = metadata.concurrencyLimits
        for (let position = 0; position < limits.length; position++) {
          const concurrency = limits[(position + repetition) % limits.length]
          samples.push(...await page.evaluate(options => window.ingestionBenchmark(options), { size, sources, repetition, concurrency, production }))
          await fs.writeFile(output, JSON.stringify({ metadata, samples }, null, 2) + "\n")
          console.log(`Completed ${sources} x ${size}, repetition ${repetition + 1}, limit ${concurrency ?? "unbounded"}`)
        }
      }
      console.log(`Completed ${sources} sources x ${size} stories`)
    }
    console.log(`Saved ${samples.length} samples to ${output}`)
  } finally {
    await browser?.close()
    if (server) await new Promise(resolve => server.close(resolve))
    await removeBenchmarkDirectory(directory)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
