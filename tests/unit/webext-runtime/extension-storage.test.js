const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { ExtensionStorage } = require("../../../packages/webext-runtime/dist")
const { NodeJsonStore } = require("../../../packages/webext-runtime/dist/node")

test("storage.local keeps items, reports changes, and survives a reload", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "once-ext-storage-"))
  const file = path.join(dir, "storage.json")
  try {
    const storage = new ExtensionStorage(new NodeJsonStore(dir), "storage.json")
    assert.deepEqual(await storage.get(null), {})
    assert.deepEqual(await storage.set({ a: 1, b: "two", skipped: undefined }), {
      a: { oldValue: undefined, newValue: 1 },
      b: { oldValue: undefined, newValue: "two" }
    })
    assert.deepEqual(await storage.get("a"), { a: 1 })
    assert.deepEqual(await storage.get(["a", "missing"]), { a: 1 })
    assert.deepEqual(await storage.get({ a: 0, c: "default" }), { a: 1, c: "default" })
    assert.deepEqual(await storage.remove("b"), { b: { oldValue: "two" } })
    await storage.flush()

    const reloaded = new ExtensionStorage(new NodeJsonStore(dir), "storage.json")
    assert.deepEqual(await reloaded.get(null), { a: 1 })
    assert.equal(await reloaded.getBytesInUse(null), Buffer.byteLength(JSON.stringify({ a: 1 })))
    assert.deepEqual(await reloaded.clear(), { a: { oldValue: 1 } })
    await reloaded.flush()
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {})
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the Node store tells a missing document from a broken one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "once-json-store-"))
  try {
    const store = new NodeJsonStore(path.join(dir, "nested"))
    assert.equal(await store.read("missing.json"), undefined)
    await store.write("doc.json", { ok: true })
    assert.deepEqual(await store.read("doc.json"), { ok: true })
    assert.equal(fs.existsSync(path.join(dir, "nested", "doc.json.tmp")), false)
    fs.writeFileSync(path.join(dir, "nested", "doc.json"), "{not json")
    await assert.rejects(store.read("doc.json"), SyntaxError)
    // Storage starts empty over a broken document rather than failing.
    const storage = new ExtensionStorage(store, "doc.json")
    assert.deepEqual(await storage.get(null), {})
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
