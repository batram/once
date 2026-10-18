const pouchModule = require("pouchdb-browser")
const findModule = require("pouchdb-find")
const PouchDB = pouchModule.default || pouchModule
PouchDB.plugin(findModule.default || findModule)
const { compactLocalRevisions } = require("../packages/persistence/dist/LocalCompaction")
const { starredStoryDocuments } = require("../packages/persistence/dist/StarredStoryIndex")
const { guardEpochWrites } = require("../packages/persistence/dist/LocalEpochWrites")

const NAME = "once-local-performance-fixture"
let db
const open = () => new PouchDB(NAME, { auto_compaction: true, revs_limit: 1000 })
function decode(value) {
  if (!value || typeof value !== "object") return value
  if (value.__blob) return new Blob([Uint8Array.from(atob(value.base64), c => c.charCodeAt(0))], { type: value.type })
  if (Array.isArray(value)) return value.map(decode)
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry)]))
}
function transaction(idb, store, write) {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(store, "readwrite")
    write(tx.objectStore(store))
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

window.prepareDatabaseBenchmark = async snapshot => {
  db = open()
  if (snapshot) {
    await db.info(); await db.close()
    const idb = await new Promise((resolve, reject) => {
      const request = indexedDB.open("_pouch_" + NAME)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    for (const store of snapshot.stores) {
      await transaction(idb, store.name, target => target.clear())
      for (let offset = 0; offset < store.values.length; offset += 1000) {
        await transaction(idb, store.name, target => {
          for (let i = offset; i < Math.min(offset + 1000, store.values.length); i++) {
            const value = decode(store.values[i])
            if (target.keyPath) target.put(value); else target.put(value, store.keys[i])
          }
        })
      }
    }
    idb.close(); db = open()
  } else {
    for (let offset = 0; offset < 33000; offset += 500) {
      const docs = []
      for (let i = offset; i < offset + 500; i++) {
        const id = "sto_" + i
        docs.push({ _id: id, _rev: `20-live-${i}`, _revisions: { start: 20, ids: [`live-${i}`, ...Array.from({ length: 19 }, (_, j) => `ancestor-${j}`)] },
          title: `Story ${i}`, stared: i % 2000 === 0, summary: "Representative story metadata. ".repeat(12) })
        if (i % 5) docs.push({ _id: id, _rev: `2-retired-${i}`, _deleted: true, _revisions: { start: 2, ids: [`retired-${i}`, `other-${i}`] } })
      }
      await db.bulkDocs(docs, { new_edits: false })
    }
  }
  // Reset only this disposable copy so both strategies perform a full scan.
  for (const id of ["_local/compaction", "_local/once-compaction-progress-v1", "_local/once-starred-index-v1"]) {
    const marker = await db.get(id).catch(error => { if (error.status === 404) return null; throw error })
    if (marker) await db.remove(marker)
  }
  return db.info()
}

window.benchmarkCompaction = async mode => {
  const stats = { mode, transactions: 0, readonly: 0, readwrite: 0, peakPending: 0, emptyCompactions: 0, realCompactions: 0 }
  let pending = 0
  const transaction = IDBDatabase.prototype.transaction, compact = db._doCompaction.bind(db)
  IDBDatabase.prototype.transaction = function (...args) {
    const tx = transaction.apply(this, args)
    stats.transactions++; stats[args[1] || "readonly"]++
    stats.peakPending = Math.max(stats.peakPending, ++pending)
    tx.addEventListener("complete", () => pending--)
    tx.addEventListener("abort", () => pending--)
    return tx
  }
  db._doCompaction = (id, revisions, callback) => {
    stats[revisions.length ? "realCompactions" : "emptyCompactions"]++
    return compact(id, revisions, callback)
  }
  window.databaseBenchmarkProgress = stats
  const start = performance.now()
  try {
    if (mode === "stock") await db.compact()
    else await compactLocalRevisions(db, () => true, (checked, compacted) => Object.assign(stats, { checked, compacted }))
    return { ...stats, ms: performance.now() - start }
  } finally { IDBDatabase.prototype.transaction = transaction; db._doCompaction = compact }
}

window.benchmarkStarred = async () => {
  const results = []
  const measure = async (name, work) => {
    const start = performance.now(), value = await work()
    results.push({ name, ms: performance.now() - start, rows: value?.docs?.length ?? null })
    return value
  }
  await measure("mango-cold-index", () => db.createIndex({ index: { fields: ["stared"], partial_filter_selector: { stared: { $eq: true } } }, ddoc: "once-stared", name: "stared-only" }))
  const mango = await measure("mango-warm", () => db.find({ selector: { stared: { $eq: true } }, use_index: ["once-stared", "stared-only"], limit: 100000 }))
  const cold = await measure("projection-cold", async () => ({ docs: await starredStoryDocuments(db) }))
  await measure("projection-warm", async () => ({ docs: await starredStoryDocuments(db) }))
  if (JSON.stringify(mango.docs.map(d => d._id).sort()) !== JSON.stringify(cold.docs.map(d => d._id).sort())) throw new Error("Starred results differ")
  return results
}

window.benchmarkWriteLocks = async () => {
  const results = [], nativeRequest = navigator.locks.request.bind(navigator.locks)
  for (const mode of ["exclusive", "shared", "shared", "exclusive"]) {
    const fixture = new PouchDB("write-fixture-" + crypto.randomUUID(), { auto_compaction: true })
    await fixture.info()
    guardEpochWrites("write-fixture", fixture)
    navigator.locks.request = (name, options, callback) => nativeRequest(name, { mode }, callback || options)
    const start = performance.now()
    let index = 0
    try {
      await Promise.all(Array.from({ length: 64 }, async () => {
        while (index < 500) {
          const i = index++
          await fixture.put({ _id: "sto_" + i, value: "metadata".repeat(60) })
        }
      }))
      results.push({ mode, documents: 500, ms: performance.now() - start })
    } finally { navigator.locks.request = nativeRequest; await fixture.destroy() }
  }
  return results
}
