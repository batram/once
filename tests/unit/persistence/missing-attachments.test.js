const test = require("node:test")
const assert = require("node:assert/strict")
const { guardMissingAttachments, isMissingAttachmentBytes } = require("../../../packages/persistence/dist")

// A transaction whose attach-store holds only the digests given.
function transaction(digests) {
  return {
    objectStore(name) {
      assert.equal(name, "attach-store")
      return {
        count(digest) {
          const request = {}
          queueMicrotask(() => { request.result = digests.includes(digest) ? 1 : 0; request.onsuccess() })
          return request
        }
      }
    }
  }
}

function read(db, digest, ctx) {
  return new Promise(resolve => db._getAttachment("sto_a", "content", { digest }, { ctx }, (error, data) => resolve({ error, data })))
}

test("a stub whose bytes are gone reads as a 404 instead of reaching the adapter", async (t) => {
  globalThis.indexedDB = {}
  t.after(() => { delete globalThis.indexedDB })
  const reads = []
  // The idb adapter assigns its reader during its async setup, after the guard.
  const db = guardMissingAttachments({ adapter: "idb", name: "once" })
  db._getAttachment = (id, name, attachment, options, callback) => {
    reads.push([attachment.digest, options.ctx])
    callback(null, "bytes")
  }
  const ctx = transaction(["md5-kept"])

  assert.deepEqual(await read(db, "md5-kept", ctx), { error: null, data: "bytes" })
  assert.deepEqual(reads, [["md5-kept", ctx]], "the check and the read share the caller's transaction")

  const { error } = await read(db, "md5-gone", ctx)
  assert.equal(error.status, 404)
  assert.equal(isMissingAttachmentBytes(error), true)
  assert.equal(reads.length, 1, "the adapter never sees the missing digest")
})

test("databases of other adapters are left alone", () => {
  const getAttachment = () => {}
  const db = { adapter: "native-sqlite", name: "once", _getAttachment: getAttachment }
  assert.equal(guardMissingAttachments(db)._getAttachment, getAttachment)
})
