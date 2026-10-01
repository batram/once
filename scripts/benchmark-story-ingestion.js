// Run after npm run build:packages. Uses disposable LevelDB databases, never user data.
const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const { performance } = require("node:perf_hooks")
const assert = require("node:assert/strict")
const PouchDB = require("pouchdb")
const { Story } = require("../packages/core/dist")
const { AppRuntime } = require("../packages/app/dist/AppRuntime")
const { PouchStoryStore } = require("../packages/persistence/dist")
const { createFakePlatform } = require("../tests/helpers/fake-platform")

const output = path.resolve(process.argv[2] || "docs/benchmarks/story-ingestion-node.json")
const samples = []
const timestamp = 1784678400000
function batch(size, source, changed = false) {
  return Array.from({ length: size }, (_, index) => {
    const story = new Story("rss", `https://benchmark.invalid/${source}/${index}`,
      `A realistic feed headline for article ${index}`, `https://benchmark.invalid/comments/${source}/${index}`, timestamp)
    story.tags.push({ class: "source", text: "Technology", href: "search:Technology" })
    if (changed) story.tags.push({ class: "source", text: "Updated", href: "search:Updated" })
    return story
  })
}
async function main() {
  await fs.mkdir(path.dirname(output), { recursive: true })
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-ingestion-bench-"))
  const metadata = { date: new Date().toISOString(), node: process.version, platform: process.platform,
    adapter: "PouchDB 9 LevelDB (Node); Electron uses IndexedDB, so timings are not renderer timings",
    archiveStories: 10000, repetitions: 5, sourceCounts: [1, 6], batchSizes: [30, 100, 300, 1000],
    timing: "processStoryInput including filters, bulk lookup, working-set merge, saves and event publication; excludes network, parsing, DB creation and archive seeding",
    phases: { cold: "new URLs in an open database with 10000 historical stories", warm: "same unchanged URLs and same runtime", warmChanged: "same URLs with one additional tag per story" } }
  try {
    for (const size of metadata.batchSizes) for (const sources of metadata.sourceCounts) {
      for (let repetition = 0; repetition < metadata.repetitions; repetition++) {
        const db = new PouchDB(path.join(directory, `${size}-${sources}-${repetition}`))
        try {
          const archive = batch(metadata.archiveStories, "archive").map(story => ({ ...story.to_obj(), _id: `sto_${story.href}`, ingested_at: timestamp }))
          const seeded = await db.bulkDocs(archive)
          assert.equal(seeded.filter(result => result.error).length, 0)
          let stats, active = 0, saves = 0
          const measuredDb = Object.create(db)
          for (const method of ["get", "put", "allDocs"]) {
            const original = db[method].bind(db)
            measuredDb[method] = async (...parameters) => {
              if (!stats) return original(...parameters)
              stats[method]++
              active++
              stats.peakDb = Math.max(stats.peakDb, active)
              try { return await original(...parameters) } finally { active-- }
            }
          }
          const store = new PouchStoryStore(measuredDb, obj => Story.from_obj(obj))
          const fake = createFakePlatform()
          fake.ports.storyStore = store
          const app = new AppRuntime(fake.ports)
          // Keep this baseline unbounded after the application gains a native gate.
          app.storyIngestion = { run: task => task() }
          const save = store.saveStory.bind(store)
          store.saveStory = async story => {
            stats.saveStory++
            saves++
            stats.peakSaves = Math.max(stats.peakSaves, saves)
            try { return await save(story) } finally { saves-- }
          }
          for (const phase of ["cold", "warm", "warmChanged"]) {
            const inputs = Array.from({ length: sources }, (_, source) => batch(size, source, phase === "warmChanged"))
            stats = { get: 0, put: 0, allDocs: 0, saveStory: 0, peakDb: 0, peakSaves: 0 }
            let maxLag = 0, expected = performance.now() + 10
            const timer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - expected); expected = now + 10 }, 10)
            const start = performance.now()
            await Promise.all(inputs.map((stories, source) => app.processStoryInput(stories, `Source ${source}`)))
            const elapsedMs = performance.now() - start
            await new Promise(resolve => setTimeout(resolve, 12))
            clearInterval(timer)
            const row = { size, sources, total: size * sources, repetition, phase, elapsedMs, maxLagMs: maxLag, ...stats }
            assert.equal(stats.allDocs, sources)
            assert.equal(stats.get, phase === "warm" ? 0 : size * sources)
            assert.equal(stats.put, phase === "warm" ? 0 : size * sources)
            samples.push(row)
            stats = undefined
            assert.equal((await db.info()).doc_count, metadata.archiveStories + size * sources)
            await fs.writeFile(output, JSON.stringify({ metadata, samples }, null, 2) + "\n")
          }
        } finally { await db.destroy() }
      }
      console.log(`Completed ${sources} sources x ${size} stories`)
    }
  } finally { await fs.rmdir(directory) }
  console.log(`Saved ${samples.length} samples to ${output}`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
