const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const test = require("node:test")
const codec = require("../../../scripts/gecko-ublock-cosmetic")
const { compactHostnameDB, compactGenericMap, scheduleLegacySelfieRewrite } = require("../../../scripts/adapt-gecko-ublock-cosmetic")
const { optimizeStorage } = require("../../../scripts/adapt-gecko-ublock")
const root = path.resolve(__dirname, "../../../vendor/extensions/ublock-origin/js")
const source = fs.readFileSync(path.join(root, "static-ext-filtering-db.js"), "utf8")
const timer = () => ({ ongoing: () => false, onidle() {}, off() {} })
function database(adapted) {
  const text = (adapted ? compactHostnameDB(source) : source)
    .replace(/^import .*once-cosmetic-cache.*\n/m, "").replace("export class", "class")
  return new Function("vAPI", "packHostnameSelfie", "unpackHostnameSelfie", text + "\nreturn new StaticExtFilteringHostnameDB();")(
    { defer: { create: timer } }, codec.packHostnameSelfie, codec.unpackHostnameSelfie)
}
function fill(db) {
  for (const [host, selector] of [["", "generic"], ["*", "wildcard"], ["example.com", "parent"],
    ["a.example.com", "specific"], ["example.com/path", "path"], ["/example\\.com$/", "regex"],
    ["/example\\.com\\/path/", "regex-path"], ["unicode.test", "\0é😀\ud800"], ["unicode.test", "\udc00"]]) db.store(host, selector)
  for (let i = 0; i < 2000; i++) db.store(`host${i}.test`, `.selector-${i}`)
}
function results(db, host, url) {
  const out = new Set()
  db.retrieveGenerics(out); db.retrieveSpecifics(out, host); db.retrieveSpecificsByRegex(out, host, url)
  return [...out]
}
function equalLookups(a, b) {
  for (const host of ["a.example.com", "example.com", "unicode.test", "missing.test", "host0.test", "host1999.test"]) {
    for (const suffix of ["/path/one", "/other"]) assert.deepEqual(results(a, host, `https://${host}${suffix}`), results(b, host, `https://${host}${suffix}`))
  }
}

test("packed and legacy snapshots preserve selectors, wildcard, suffix, path and regex matching", () => {
  const original = database(false); fill(original)
  const updated = database(true); updated.fromSelfie(structuredClone(original.toSelfie()))
  const packed = structuredClone(updated.toSelfie())
  assert.equal(packed.VERSION, "once-packed-1")
  assert.ok(packed.linkedLists instanceof Uint32Array)
  assert.equal(packed.strSlots, undefined)
  const restored = database(true); restored.fromSelfie(packed)
  equalLookups(original, restored)
  assert.throws(() => database(false).fromSelfie(packed), /Bad selfie/, "rollback must reject the new encoding and use upstream fallback")
})

test("append, duplicate targets, clear and repeated cache writes work after a packed restore", () => {
  const original = database(false); fill(original)
  let updated = database(true); updated.fromSelfie(structuredClone(original.toSelfie()))
  updated = (() => { const d = database(true); d.fromSelfie(structuredClone(updated.toSelfie())); return d })()
  for (const [host, selector] of [["example.com", "appended"], ["example.com/path", "new-path"], ["/.*\\.test$/", "new-regex"]]) {
    original.store(host, selector); updated.store(host, selector)
  }
  equalLookups(original, updated)
  const again = database(true); again.fromSelfie(structuredClone(updated.toSelfie())); equalLookups(original, again)
  original.clear(); again.clear(); original.store("example.com", "only"); again.store("example.com", "only")
  equalLookups(original, again)
  assert.equal(again.size, 1)
})

test("packed numeric and string indexes preserve lookup values and materialize correctly on edits", () => {
  for (const entries of [[], [[0, ""], [4294967295, "\0😀"], [7, "selector"]], [["", 0], ["a", 3], ["é", 9], ["\ud800", 5]]]) {
    const map = new Map(entries)
    const packed = codec.unpackFilterIndex(structuredClone(codec.packFilterIndex(map)))
    for (const [key, value] of entries) { assert.equal(packed.has(key), true); assert.equal(packed.get(key), value) }
    assert.equal(packed.get("missing"), undefined)
    assert.equal(packed.get({}), undefined)
    assert.equal(packed.size, map.size)
    packed.set("new", "value"); map.set("new", "value")
    for (const [key, value] of map) assert.equal(packed.get(key), value)
    if (entries.length) { packed.set(entries[0][0], "changed"); assert.equal(packed.get(entries[0][0]), "changed") }
    packed.clear(); assert.equal(packed.size, 0); assert.equal(packed.get("new"), undefined)
  }
})

test("malformed packed tables are rejected before they can be used for filtering", () => {
  const db = database(true); fill(db)
  const packed = db.toSelfie()
  for (const change of [s => { s.VERSION = "unknown" }, s => { s.offsets[0] = 1 },
    s => { s.offsets[s.offsets.length - 1]++ }, s => { s.offsets[2] = 0xffffffff },
    s => { s.linkedLists = [] }, s => { s.hostnameToStringListMap.keys.offsets[0] = 1 }]) {
    const bad = structuredClone(packed); change(bad)
    assert.throws(() => database(true).fromSelfie(bad), /Bad|Unsorted/)
  }
  const bad = codec.packFilterIndex(new Map([[1, "a"], [2, "b"]])); bad.keys.reverse()
  assert.throws(() => codec.unpackFilterIndex(bad), /Unsorted/)
})

test("the upstream serializer round-trips binary tables and exact UTF-16 selector content", () => {
  const text = fs.readFileSync(path.join(root, "s14e-serializer.js"), "utf8").replace(/^export /gm, "")
  const { serialize, deserialize } = new Function(text + "\nreturn {serialize,deserialize};")()
  const original = database(false); fill(original)
  const updated = database(true); updated.fromSelfie(original.toSelfie())
  const restored = database(true)
  restored.fromSelfie(deserialize(serialize(updated.toSelfie(), { compress: true })))
  equalLookups(original, restored)
})

test("generic map adaptation only replaces the cache boundary and supports every used map method", () => {
  const original = fs.readFileSync(path.join(root, "cosmetic-filtering.js"), "utf8")
  const methods = [...original.matchAll(/this\.lowlyGeneric\.([A-Za-z]+)/g)].map(m => m[1])
  assert.ok(methods.every(name => ["get", "set", "has", "clear", "size", "values"].includes(name)))
  const adapted = compactGenericMap(original)
  assert.match(adapted, /lowlyGeneric: packFilterIndex/)
  assert.match(adapted, /lowlyGeneric = unpackFilterIndex/)
})

for (const legacy of [true, false]) test(`snapshot migration is delayed and does not move request readiness: legacy=${legacy}`, async () => {
  const text = scheduleLegacySelfieRewrite(optimizeStorage(fs.readFileSync(path.join(root, "storage.js"), "utf8")))
  const begin = text.indexOf("    const load = async function() {", text.indexOf("const loadMain ="))
  const end = text.indexOf("    const destroy =", begin)
  const scheduled = []
  const load = new Function("µb", "startupSelfie", "loadMain", "staticExtFilteringEngine", "staticNetFilteringEngine", "createTimer", "destroy", "ubolog",
    text.slice(begin, end) + "return load;")(
    { selfieIsInvalid: false, hiddenSettings: { selfieDelayInSeconds: 120 }, loadRedirectResources: async () => true },
    { generation: 0, read: async () => ({ cosmetic: { specificFilters: { VERSION: legacy ? 1 : "once-packed-1" } } }) },
    async () => true, { fromSelfie: async () => true }, { fromSelfie: async () => true },
    { onidle: (...args) => scheduled.push(args) }, () => {}, () => {})
  assert.equal(await load(), true)
  assert.equal(scheduled.length, legacy ? 1 : 0)
  if (legacy) assert.deepEqual(scheduled[0], [{ sec: 120 }, { timeout: 10000 }])
})


test("the generated Android codec is a loadable ES module", async () => {
  const { adaptGeckoUblock } = require("../../../scripts/adapt-gecko-ublock")
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "once-cosmetic-module-"))
  try {
    adaptGeckoUblock(path.dirname(root), path.join(target, "extension"), "test-pin")
    const source = fs.readFileSync(path.join(target, "extension/js/once-cosmetic-cache.js"), "utf8")
    const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
    const index = module.unpackFilterIndex(module.packFilterIndex(new Map([[2, "two"], [1, "one"]])))
    assert.equal(index.get(2), "two")
    assert.equal(index.size, 2)
  } finally { fs.rmSync(target, { recursive: true, force: true }) }
})
