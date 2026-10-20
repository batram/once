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

function keyedStore(initial) {
  let data = { ...initial }
  const reads = []
  return {
    reads,
    snapshot: () => data,
    async read() { reads.push(null); return { ...data } },
    async readKeys(_name, keys) {
      reads.push(keys)
      return Object.fromEntries(keys.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]]))
    },
    async write() { throw Error("Partial storage must not replace the document") },
    async patch(_name, set, remove) {
      data = { ...data, ...set }
      data = Object.fromEntries(Object.entries(data).filter(([key]) => !remove.includes(key)))
    }
  }
}

test("keyed storage caches misses, batches requested keys and leaves large values unread", async () => {
  const store = keyedStore({ small: 1, cache: "x".repeat(1000000) })
  const storage = new ExtensionStorage(store, "storage.json")
  assert.deepEqual(await storage.get({ small: 0, absent: "fallback" }), { small: 1, absent: "fallback" })
  assert.deepEqual(await storage.get(["small", "absent"]), { small: 1 })
  assert.deepEqual(store.reads, [["small", "absent"]])
  assert.equal(storage.someKey(key => key === "cache"), undefined, "partial knowledge is not proof of absence")
  assert.deepEqual(await storage.set({ small: 2, added: 3 }), {
    small: { oldValue: 1, newValue: 2 }, added: { oldValue: undefined, newValue: 3 }
  })
  await storage.remove("small")
  assert.deepEqual(await storage.get(null), { cache: "x".repeat(1000000), added: 3 })
  assert.equal(storage.someKey(key => key === "missing"), false)
  await storage.flush()
  assert.deepEqual(store.snapshot(), { cache: "x".repeat(1000000), added: 3 })
  await storage.clear()
  await storage.flush()
  assert.deepEqual(store.snapshot(), {})
})

test("overlapping keyed reads share loaded keys and a failed read is retried", async () => {
  const store = keyedStore({ a: 1, b: 2 })
  const read = store.readKeys
  let fail = true
  store.readKeys = async (...args) => { if (fail) { fail = false; throw Error("read failed") } return read(...args) }
  const storage = new ExtensionStorage(store, "storage.json")
  await assert.rejects(storage.get("a"), /read failed/)
  assert.deepEqual(await Promise.all([storage.get(["a", "b"]), storage.get("a")]), [{ a: 1, b: 2 }, { a: 1 }])
  assert.deepEqual(store.reads, [["a", "b"]])
})

test("failed partial patches retry current values without overwriting unread data", async () => {
  const store = keyedStore({ setting: 1, untouched: "cache" })
  const patch = store.patch
  let fail = true
  store.patch = async (...args) => { if (fail) { fail = false; throw Error("disk unavailable") } return patch(...args) }
  const storage = new ExtensionStorage(store, "storage.json")
  await storage.set({ setting: 2 })
  await storage.flush()
  await storage.set({ setting: 3 })
  await storage.flush()
  assert.deepEqual(store.snapshot(), { setting: 3, untouched: "cache" })
  assert.deepEqual(store.reads, [["setting"]])
})

test("a full read racing a local change preserves the local value and deletion", async () => {
  const store = keyedStore({ a: 1, b: 2, unseen: 3 })
  const storage = new ExtensionStorage(store, "storage.json")
  await storage.get(["a", "b"])
  let release
  store.read = () => new Promise(resolve => { release = () => resolve({ a: 1, b: 2, unseen: 3 }) })
  const all = storage.get(null)
  await Promise.resolve()
  await storage.set({ a: 9 })
  await storage.remove("b")
  release()
  assert.deepEqual(await all, { a: 9, unseen: 3 })
  await storage.flush()
  assert.deepEqual(store.snapshot(), { a: 9, unseen: 3 })
})

test("concurrent disjoint keyed reads share one request and retain independent defaults", async () => {
  const store = keyedStore({ a: 1, b: 2, large: "untouched" })
  const storage = new ExtensionStorage(store, "storage.json")
  assert.deepEqual(await Promise.all([
    storage.get({ a: 0, missing: "first" }), storage.get(["b", "a"]), storage.get({ missing: "second" })
  ]), [{ a: 1, missing: "first" }, { b: 2, a: 1 }, { missing: "second" }])
  assert.deepEqual(store.reads, [["a", "missing", "b"]])
})

test("reads queued behind an active request batch together and retry together after failure", async () => {
  const store = keyedStore({ a: 1, b: 2, c: 3 })
  const read = store.readKeys
  let release
  store.readKeys = async (name, keys) => {
    if (keys.includes("a")) await new Promise(resolve => { release = resolve })
    return read(name, keys)
  }
  const storage = new ExtensionStorage(store, "storage.json")
  const first = storage.get("a")
  await Promise.resolve()
  const others = [storage.get("b"), storage.get("c")]
  release()
  assert.deepEqual(await Promise.all([first, ...others]), [{ a: 1 }, { b: 2 }, { c: 3 }])
  assert.deepEqual(store.reads, [["a"], ["b", "c"]])
  store.readKeys = async () => { throw Error("failed batch") }
  const failed = await Promise.allSettled([storage.get("d"), storage.get("e")])
  assert.ok(failed.every(result => result.status === "rejected"))
  store.readKeys = read
  assert.deepEqual(await Promise.all([storage.get("d"), storage.get("e")]), [{}, {}])
  assert.deepEqual(store.reads.at(-1), ["d", "e"])
})

test("full enumeration separates keyed batches and supplies later queued reads", async () => {
  const store = keyedStore({ a: 1, b: 2 })
  const storage = new ExtensionStorage(store, "storage.json")
  assert.deepEqual(await Promise.all([storage.get("a"), storage.get(null), storage.get("b")]), [
    { a: 1 }, { a: 1, b: 2 }, { b: 2 }
  ])
  assert.deepEqual(store.reads, [["a"], null], "the later key was not pulled ahead of full enumeration")
})
