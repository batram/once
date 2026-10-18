const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const { nativePouchAdapter } = require("../../../packages/platform-mobile/dist/nativePouchAdapter")
const { sqliteBridge } = require("../../helpers/native-sqlite-bridge")
const { nativeStorageConformance } = require("../../helpers/native-storage-conformance")

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
    const keyed = await db.allDocs({ keys: Array.from({ length: 1000 }, (_, i) => `doc_${i}`), include_docs: true })
    assert.equal(keyed.rows.length, 1000)
    assert.equal(keyed.rows[999].doc.value, 999)
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
