// Disposable HTTP/PouchDB benchmark. Never connects to a production endpoint.
// Run after build:packages: node scripts/benchmark-database.js <label> [documents] [latency-ms]
const fs = require("node:fs/promises")
const path = require("node:path")
const express = require("express")
const expressPouchDB = require("../tests/helpers/couch-server")
const PouchDB = require("pouchdb")
const { copyWinningRevisions, verifyWinningRevisions } = require("../packages/persistence/dist")
const { isSyncMetadataId, SYNC_COMPAT_ID, SYNC_EPOCH_ID, SYNC_EPOCH_FENCE_ID } = require("../packages/core/dist")

async function main() {
  const label = process.argv[2] || "current"
  if (!/^[a-z0-9-]+$/i.test(label)) throw new Error("Use a simple benchmark label")
  const documents = Number(process.argv[3] || 5000), latencyMs = Number(process.argv[4] || 25)
  if (!Number.isSafeInteger(documents) || documents < 1 || !Number.isFinite(latencyMs) || latencyMs < 0) throw new Error("Invalid benchmark parameters")
  const directory = path.resolve("artifacts/performance", `database-${label}-${Date.now()}`)
  await fs.mkdir(directory, { recursive: true })
  const Db = PouchDB.defaults({ prefix: directory + path.sep })
  const api = expressPouchDB(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const source = new Db("source"), target = new Db("target")
  await target.info()
  for (let offset = 0; offset < documents; offset += 500) {
    await source.bulkDocs(Array.from({ length: Math.min(500, documents - offset) }, (_, i) => ({
      _id: `sto_${String(offset + i).padStart(8, "0")}`, title: `Story ${offset + i}`,
      timestamp: 1784678400000, read_state: "unread", stared: false,
      tags: [{ class: "source", text: "Benchmark", href: "https://benchmark.invalid/feed" }],
      summary: "Representative article metadata. ".repeat(12)
    })))
  }
  const app = express()
  let stats
  app.use((request, response, next) => {
    const current = stats
    if (current) {
      const endpoint = request.path.split("/")[2] || "info"
      current.requests++
      current.endpoints[endpoint] = (current.endpoints[endpoint] || 0) + 1
      if (endpoint === "_changes" && request.query.include_docs === "true") current.bodyFeeds++
      const write = response.write.bind(response), end = response.end.bind(response)
      const count = chunk => { if (chunk) current.bytes += Buffer.byteLength(chunk) }
      response.write = (chunk, ...rest) => { count(chunk); return write(chunk, ...rest) }
      response.end = (chunk, ...rest) => { count(chunk); return end(chunk, ...rest) }
    }
    setTimeout(next, latencyMs)
  })
  app.use(api)
  const server = await new Promise(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const remoteSource = new PouchDB(base + "/source", { skip_setup: true })
  const remoteTarget = new PouchDB(base + "/target", { skip_setup: true })
  const report = { label, at: new Date().toISOString(), documents, latencyMs, node: process.version, phases: [] }
  const measure = async (name, work) => {
    stats = { name, requests: 0, bytes: 0, bodyFeeds: 0, endpoints: {} }
    const start = performance.now(), result = await work()
    const phase = { ...stats, ms: performance.now() - start }
    stats = null
    report.phases.push(phase)
    await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n")
    console.log(JSON.stringify(phase))
    return result
  }
  try {
    await measure("copy", () => copyWinningRevisions(remoteSource, remoteTarget, "fixture"))
    const verified = await measure("verify", () => verifyWinningRevisions(remoteSource, remoteTarget))
    if (!verified.ok) throw new Error("Fixture verification failed")
    for (const mode of ["function-filter", "selector"]) {
      const replica = new Db("replica-" + mode)
      try {
        await source.replicate.to(replica)
        const options = mode === "function-filter" ? { filter: doc => !isSyncMetadataId(doc._id) } :
          { selector: { _id: { $nin: [SYNC_COMPAT_ID, SYNC_EPOCH_ID, SYNC_EPOCH_FENCE_ID] } } }
        const result = await measure("unchanged-pull-" + mode, () => replica.replicate.from(remoteSource, { batch_size: 1000, batches_limit: 2, checkpoint: "target", ...options }))
        if (result.docs_written !== 0) throw new Error("Unchanged fixture unexpectedly wrote documents")
      } finally { await replica.close() }
    }
  } finally {
    await Promise.all([source.close(), target.close(), remoteSource.close(), remoteTarget.close()])
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  console.log(`Saved ${path.join(directory, "report.json")}`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
