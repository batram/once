const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const { nativePouchAdapter } = require("../../../packages/platform-mobile/dist/nativePouchAdapter")
const { sqliteBridge } = require("../../helpers/native-sqlite-bridge")
const { nativeStorageConformance } = require("../../helpers/native-storage-conformance")
const { Story } = require("../../../packages/core/dist")
const { PouchStoryStore } = require("../../../packages/persistence/dist")

test("native storage preserves revision branches, large attachments, deletion and checkpoints", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-native-storage-"))
  try {
    PouchDB.plugin(nativePouchAdapter(sqliteBridge(directory)))
    await nativeStorageConformance(PouchDB, "conformance-")
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test("native changes read ahead in bounded pages and invalidate cached metadata on writes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-native-read-ahead-"))
  const bridge = sqliteBridge(directory)
  let reads = 0, largest = 0
  const transport = { execute: async request => {
    if (request.operation === "getMany") { reads++; largest = Math.max(largest, request.keys.length) }
    return bridge.execute(request)
  } }
  PouchDB.plugin(nativePouchAdapter(transport))
  const db = new PouchDB("read-ahead", { adapter: "native-sqlite" })
  try {
    await db.bulkDocs(Array.from({ length: 1000 }, (_, i) => ({ _id: `doc_${i}`, value: i })))
    reads = 0
    largest = 0
    const changes = await db.changes({ since: 0, include_docs: true })
    assert.equal(changes.results.length, 1000)
    assert.ok(reads < 20, `Expected batched reads, observed ${reads}`)
    assert.ok(largest <= 128)
    reads = 0
    largest = 0
    const keyed = await db.allDocs({ keys: Array.from({ length: 1000 }, (_, i) => `doc_${i}`), include_docs: true })
    assert.equal(keyed.rows.length, 1000)
    assert.equal(keyed.rows[999].doc.value, 999)
    assert.ok(reads < 25, `Expected batched keyed snapshots and bodies, observed ${reads}`)
    assert.ok(largest <= 128)
    reads = 0
    const shortRange = await db.allDocs({ startkey: "doc_100", endkey: "doc_199", include_docs: true })
    assert.equal(shortRange.rows.length, 109)
    assert.ok(reads < 8, `Completed range pages still prefetch bodies, observed ${reads} reads`)
    const before = await db.get("doc_999")
    await db.put({ ...before, value: "updated" })
    assert.equal((await db.get("doc_999")).value, "updated")
    await db.remove(await db.get("doc_999"))
    await assert.rejects(db.get("doc_999"), { status: 404 })
  } finally {
    await db.destroy()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("full range pages keep their bound and release the final snapshot before end", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-native-page-boundary-"))
  const db = rawDatabase(sqliteBridge(directory))
  const iterators = []
  try {
    await invoke(db, "open")
    await invoke(db, "batch", Array.from({ length: 256 }, (_, i) => ({
      type: "put", key: String(i).padStart(3, "0"), value: String(i)
    })))
    const exact = db.iterator({ lt: "128" })
    iterators.push(exact)
    assert.equal((await exact.opened).iterator, null, "exactly 128 rows fit in one page")
    for (let i = 0; i < 64; i++) iterators.push(db.iterator({}))
    const active = await Promise.all(iterators.slice(1).map(iterator => iterator.opened))
    assert.ok(active.every(result => result.iterator !== null), "multi-page ranges retain their snapshots")
    const short = db.iterator({ lt: "001" })
    try {
      assert.equal((await short.opened).iterator, null, "short ranges still succeed at capacity")
      assert.equal((await invoke(short, "next")).length, 2)
    } finally { await invoke(short, "end") }
    const excess = db.iterator({})
    await assert.rejects(excess.opened, /Too many open range snapshots/)
    await assert.rejects(invoke(excess, "end"), /Too many open range snapshots/)
    // Finish the retained ranges without ending their JavaScript iterators.
    await Promise.all(iterators.slice(1).map(async iterator => {
      for (let i = 0; i < 256; i++) assert.equal((await invoke(iterator, "next")).length, 2)
      assert.equal(iterator.done, true)
      assert.deepEqual(await invoke(iterator, "next"), [])
    }))
    const fresh = db.iterator({})
    iterators.push(fresh)
    assert.notEqual((await fresh.opened).iterator, null, "final pages released native capacity")
  } finally {
    await Promise.allSettled(iterators.map(iterator => invoke(iterator, "end")))
    await invoke(db, "close")
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function rawDatabase(transport) {
  // Capture LevelPouch's byte-store factory so snapshot ordering is exercised
  // directly, independently of PouchDB's own operation queues.
  const module = { exports: {} }
  const filename = require.resolve("../../../packages/platform-mobile/dist/nativePouchAdapter")
  const code = fs.readFileSync(filename, "utf8")
  let factory
  Function("module", "exports", "require", code)(module, module.exports, name =>
    name === "pouchdb-adapter-leveldb-core" ? function (options) { factory = options.db } : require(name))
  module.exports.nativePouchAdapter(transport)({ adapter(_name, Adapter) { new Adapter({}) } })
  return factory("snapshots")
}

const invoke = (db, method, ...args) => new Promise((resolve, reject) =>
  db[method](...args, (error, ...values) => error ? reject(error) : resolve(values)))

test("batched point snapshots precede same-turn writes and respect iterator options", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-native-points-"))
  const bridge = sqliteBridge(directory)
  const operations = []
  const db = rawDatabase({ execute: request => {
    operations.push(request.operation)
    return bridge.execute(request)
  } })
  try {
    await invoke(db, "open")
    await invoke(db, "put", "a", "old")
    operations.length = 0
    const before = db.iterator({ gte: "a", lte: "a", keyAsBuffer: false, valueAsBuffer: false })
    const empty = db.iterator({ gte: "a", lte: "a", limit: 0 })
    const keysOnly = db.iterator({ gte: "a", lte: "a", values: false, keyAsBuffer: false })
    const missing = db.iterator({ gte: "missing", lte: "missing" })
    const write = invoke(db, "put", "a", "new")
    assert.deepEqual(operations, ["getMany", "batch"], "snapshots are sent before the write")
    await write
    assert.deepEqual(await invoke(before, "next"), ["a", "old"])
    assert.deepEqual(await invoke(empty, "next"), [])
    assert.deepEqual(await invoke(keysOnly, "next"), ["a", undefined])
    assert.deepEqual(await invoke(missing, "next"), [])
    await Promise.all([before, empty, keysOnly, missing].map(iterator => invoke(iterator, "end")))
    const [value] = await invoke(db, "get", "a", { asBuffer: false })
    assert.equal(value, "new")
  } finally {
    await invoke(db, "close")
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("a failed point-read batch rejects every snapshot", async () => {
  const db = rawDatabase({ execute: async request => {
    if (request.operation === "getMany") throw new Error("read failed")
    return {}
  } })
  await invoke(db, "open")
  const first = db.iterator({ gte: "a", lte: "a" })
  const second = db.iterator({ gte: "b", lte: "b" })
  await Promise.all([first, second].map(iterator => assert.rejects(invoke(iterator, "next"), /read failed/)))
  await invoke(db, "close")
})

test("range first pages retain snapshot order across writes and subsequent pages", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-native-range-"))
  const bridge = sqliteBridge(directory)
  const operations = []
  const db = rawDatabase({ execute: request => { operations.push(request.operation); return bridge.execute(request) } })
  try {
    await invoke(db, "open")
    await invoke(db, "batch", Array.from({ length: 260 }, (_, i) => ({ type: "put", key: String(i).padStart(3, "0"), value: `old-${i}` })))
    operations.length = 0
    const iterator = db.iterator({ reverse: true, limit: 250, keyAsBuffer: false, valueAsBuffer: false })
    await invoke(db, "put", "259", "new")
    const first = await invoke(iterator, "next")
    assert.deepEqual(first, ["259", "old-259"])
    assert.equal(operations.includes("iteratorNext"), false, "first page arrives with the open")
    const rows = [first]
    for (;;) { const row = await invoke(iterator, "next"); if (!row.length) break; rows.push(row) }
    assert.equal(rows.length, 250)
    assert.deepEqual(rows.at(-1), ["010", "old-10"])
    assert.equal(operations.filter(x => x === "iteratorNext").length, 1)
    await invoke(iterator, "end")
    assert.equal((await invoke(db, "get", "259", { asBuffer: false }))[0], "new")
  } finally {
    await invoke(db, "close")
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("concurrent story observation ranges release materialized snapshots before iterator end", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-native-observations-"))
  const db = rawDatabase(sqliteBridge(directory))
  const iterators = []
  try {
    await invoke(db, "open")
    await invoke(db, "batch", Array.from({ length: 96 }, (_, i) => ({
      type: "put", key: `obs_${i}|1`, value: `old-${i}`
    })))
    // Story loading fans out prefix ranges, including empty ones. None of
    // these callers has consumed or ended its iterator when the burst opens.
    for (let i = 0; i < 192; i++) iterators.push(db.iterator({
      gte: `obs_${i}|`, lt: `obs_${i}|~`, keyAsBuffer: false, valueAsBuffer: false
    }))
    await invoke(db, "put", "obs_0|1", "new")
    const rows = await Promise.all(iterators.map(iterator => invoke(iterator, "next")))
    for (let i = 0; i < 192; i++) assert.deepEqual(rows[i], i < 96 ? [`obs_${i}|1`, `old-${i}`] : [])
    assert.ok(iterators.every(iterator => iterator.done), "short ranges finish in their initial page")
    assert.ok((await Promise.all(iterators.map(iterator => iterator.opened))).every(result => result.iterator === null),
      "materialized ranges retain no native handle")
  } finally {
    await Promise.allSettled(iterators.map(iterator => invoke(iterator, "end")))
    await invoke(db, "close")
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("native story loading resolves hundreds of concurrent observation prefixes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-native-stories-"))
  PouchDB.plugin(nativePouchAdapter(sqliteBridge(directory)))
  const db = new PouchDB("story-observations", { adapter: "native-sqlite" })
  try {
    const urls = Array.from({ length: 270 }, (_, i) => `https://example.test/story-${i}`)
    await db.bulkDocs(urls.flatMap((href, i) => [
      { ...new Story("HN", href, `Story ${i}`, "", 0).to_obj(), _id: `sto_${href}` },
      { _id: `obs_${encodeURIComponent(href)}|123`, href, ingested_at: 123 }
    ]))
    const store = new PouchStoryStore(db, Story.from_obj.bind(Story))
    const stories = await store.getStoriesByUrls(urls)
    assert.equal(stories.size, urls.length)
    for (const [i, href] of urls.entries()) {
      assert.equal(stories.get(href).title, `Story ${i}`)
      assert.equal(stories.get(href).ingested_at, 123)
    }
  } finally {
    await db.destroy()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
