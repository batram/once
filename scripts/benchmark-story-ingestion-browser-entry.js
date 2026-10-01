const pouchModule = require("pouchdb-browser")
const PouchDB = pouchModule.default || pouchModule
const { Story } = require("../packages/core/dist")
const { AppRuntime } = require("../packages/app/dist/AppRuntime")
const { PouchStoryStore, LOCAL_POUCH_OPTIONS } = require("../packages/persistence/dist")
const { createFakePlatform } = require("../tests/helpers/fake-platform")

window.ingestionBenchmark = async ({ size, sources, repetition, concurrency = null, production = false }) => {
  const db = new PouchDB(`once-ingestion-benchmark-${crypto.randomUUID()}`, LOCAL_POUCH_OPTIONS)
  const batch = (size, source, changed = false) => Array.from({ length: size }, (_, index) => {
    const story = new Story("rss", `https://benchmark.invalid/${source}/${index}`,
      `A realistic feed headline for article ${index}`, `https://benchmark.invalid/comments/${source}/${index}`, 1784678400000)
    story.tags.push({ class: "source", text: "Technology", href: "search:Technology" })
    if (changed) story.tags.push({ class: "source", text: "Updated", href: "search:Updated" })
    return story
  })
  try {
    const seeded = await db.bulkDocs(batch(10000, "archive").map(story => ({ ...story.to_obj(), _id: `sto_${story.href}`, ingested_at: 1784678400000 })))
    if (seeded.some(result => result.error)) throw new Error("Archive seed failed")
    let stats, active = 0, saves = 0
    const measuredDb = Object.create(db)
    for (const method of ["get", "put", "allDocs"]) {
      measuredDb[method] = async (...parameters) => {
        stats[method]++
        active++
        stats.peakDb = Math.max(stats.peakDb, active)
        try { return await db[method](...parameters) } finally { active-- }
      }
    }
    const store = new PouchStoryStore(measuredDb, obj => Story.from_obj(obj))
    const save = store.saveStory.bind(store)
    store.saveStory = async story => {
      stats.saveStory++
      saves++
      stats.peakSaves = Math.max(stats.peakSaves, saves)
      try { return await save(story) } finally { saves-- }
    }
    const fake = createFakePlatform()
    fake.ports.storyStore = store
    const app = new AppRuntime(fake.ports)
    if (!production) {
      // Preserve the original experiment after production gains its own gate.
      app.storyIngestion = { run: task => task() }
    }
    // Experiment only: one gate per runtime, shared by all source batches.
    // Gate the complete story operation, retaining the real per-URL write queue.
    let activeStories = 0, peakStories = 0
    const waiting = []
    const observedMethod = production ? "addStoryNow" : "addStory"
    const originalAddStory = app[observedMethod].bind(app)
    app[observedMethod] = async (...parameters) => {
      if (!production && concurrency !== null && activeStories >= concurrency) {
        await new Promise(resolve => waiting.push(resolve))
      } else activeStories++
      peakStories = Math.max(peakStories, activeStories)
      try { return await originalAddStory(...parameters) }
      finally {
        const next = waiting.shift()
        if (next) next()
        else activeStories--
      }
    }
    const results = []
    for (const phase of ["cold", "warm", "warmChanged"]) {
      const inputs = Array.from({ length: sources }, (_, source) => batch(size, source, phase === "warmChanged"))
      stats = { get: 0, put: 0, allDocs: 0, saveStory: 0, peakDb: 0, peakSaves: 0 }
      peakStories = 0
      let maxLag = 0, expected = performance.now() + 10
      const timer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - expected); expected = now + 10 }, 10)
      const start = performance.now()
      await Promise.all(inputs.map((stories, source) => app.processStoryInput(stories, `Source ${source}`)))
      const elapsedMs = performance.now() - start
      await new Promise(resolve => setTimeout(resolve, 12))
      clearInterval(timer)
      const total = size * sources
      if (stats.allDocs !== sources || stats.get !== (phase === "warm" ? 0 : total) || stats.put !== (phase === "warm" ? 0 : total)) {
        throw new Error(`Unexpected operation counts: ${JSON.stringify(stats)}`)
      }
      if ((await db.info()).doc_count !== 10000 + total) throw new Error("Document count mismatch")
      if (concurrency !== null && (peakStories > concurrency || stats.peakSaves > concurrency)) throw new Error("Shared concurrency limit exceeded")
      if (activeStories !== 0 || waiting.length !== 0) throw new Error("Gate did not drain")
      const saved = await db.get("sto_https://benchmark.invalid/0/0")
      if (phase === "warmChanged" && !saved.tags.some(tag => tag.text === "Updated")) throw new Error("Changed tags not persisted")
      results.push({ size, sources, total, repetition, concurrency, production, phase, elapsedMs, maxLagMs: maxLag, peakStories, ...stats })
    }
    return results
  } finally { await db.destroy() }
}
