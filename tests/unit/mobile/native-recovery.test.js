const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const ts = require("typescript")
const PouchDB = require("pouchdb")
const persistence = require("../../../packages/persistence/dist")

async function fixture(t, legacy = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-native-recovery-"))
  const handles = []
  const open = name => { const db = new PouchDB(path.join(directory, name)); handles.push(db); return db }
  let pointer = ""
  let pointerWrites = 0
  function Database(name) {
    const db = open(name.startsWith("https:") ? "remote" : name)
    if (name.startsWith("https:")) db.fetch = async requestPath => {
      const url = new URL(requestPath, "https://example.test/")
      const doc = await db.get(decodeURIComponent(url.pathname.slice(1)), { rev: url.searchParams.get("rev") || undefined, attachments: true })
      return new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } })
    }
    return db
  }
  Database.plugin = () => Database
  Database.replicate = PouchDB.replicate.bind(PouchDB)
  const modules = {
    "pouchdb-browser": Database,
    "@capacitor/core": { Capacitor: { getPlatform: () => "android" } },
    "@once/core": require("../../../packages/core/dist"),
    "@once/persistence": persistence,
    "./NativeLevel": { NativeLevel: { execute: async request => {
      if (request.operation === "readPointer") return { value: pointer }
      if (request.operation === "writePointer") { pointer = request.value; pointerWrites++; return {} }
      throw new Error("Unexpected bridge operation")
    } } },
    "./nativePouchAdapter": { nativePouchAdapter: () => () => {} },
    "./nativeFetch": { nativeFetch: fetch }
  }
  const source = fs.readFileSync(path.resolve(__dirname, "../../../packages/platform-mobile/src/nativeStorage.ts"), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  new Function("require", "module", "exports", "indexedDB", "localStorage", compiled)(name => {
    if (!(name in modules)) throw new Error("Unexpected import " + name)
    return modules[name]
  }, module, module.exports, { databases: async () => legacy ? [{ name: "_pouch_once_mobile_v1" }] : [] }, { getItem: () => null })
  t.after(async () => {
    await Promise.allSettled(handles.map(db => db.close()))
    for (const name of new Set(handles.map(db => db.name))) await new PouchDB(name).destroy()
    fs.rmdirSync(directory)
  })
  return { open, prepare: module.exports.prepareMobileDatabase, pointer: () => pointer, pointerWrites: () => pointerWrites,
    setPointer: value => { pointer = value } }
}

test("missing browser database recovers server settings and attachments before committing a native pointer", async t => {
  const f = await fixture(t), remote = f.open("remote")
  await remote.bulkDocs([
    { _id: "settings", theme: "dark" },
    { _id: "story", _attachments: { content: { content_type: "text/plain", data: Buffer.from("saved offline content").toString("base64") } } },
    { _id: "once_sync_compat", minSyncProtocol: 4 }
  ])
  const before = await remote.info()
  await f.prepare("https://example.test/once_e2", () => {})
  const target = f.open("once_mobile_native_v1")
  assert.equal((await target.get("settings")).theme, "dark")
  assert.equal((await target.getAttachment("story", "content")).toString(), "saved offline content")
  assert.equal((await target.get("_local/once-sync-epoch")).destination, "https://example.test/once_e2")
  await assert.rejects(target.get("once_sync_compat"), { status: 404 })
  assert.equal(JSON.parse(f.pointer()).name, "once_mobile_native_v1")
  assert.equal((await remote.info()).update_seq, before.update_seq)
})

test("unresolved source conflicts block activation and retain both branches", { timeout: 15000 }, async t => {
  const f = await fixture(t), remote = f.open("remote")
  await remote.bulkDocs([
    { _id: "settings", _rev: "1-a", _revisions: { start: 1, ids: ["a"] }, value: "a" },
    { _id: "settings", _rev: "1-b", _revisions: { start: 1, ids: ["b"] }, value: "b" }
  ], { new_edits: false })
  await assert.rejects(f.prepare("https://example.test/once_e2", () => {}), /conflicts/)
  assert.equal(f.pointerWrites(), 0)
  assert.equal((await f.open("remote").get("settings", { conflicts: true }))._conflicts.length, 1)
  await assert.rejects(f.open("once_mobile_native_v1").get("_local/once-native-storage-v1"), { status: 404 })
})

test("a missing native database behind an existing pointer cannot initialize defaults", async t => {
  const f = await fixture(t)
  f.setPointer(JSON.stringify({ name: "once_mobile_native_v1" }))
  await assert.rejects(f.prepare("", () => {}), /metadata is missing/)
  assert.equal(f.pointerWrites(), 0)
  assert.equal((await f.open("once_mobile_native_v1").info()).doc_count, 0)
})

test("adapter migration preserves old epoch version so reconciliation is not bypassed", async t => {
  const f = await fixture(t, true), legacy = f.open("once_mobile_v1")
  await legacy.put({ _id: "settings", value: "pending local setting" })
  await legacy.put({ _id: "_local/once-sync-epoch", destination: "https://example.test/once_e2", version: 3 })
  await f.prepare("", () => {})
  const target = f.open("once_mobile_native_v1")
  assert.equal((await target.get("settings")).value, "pending local setting")
  assert.equal((await target.get("_local/once-sync-epoch")).version, 3)
  assert.equal((await f.open("once_mobile_v1").get("settings")).value, "pending local setting")
})
