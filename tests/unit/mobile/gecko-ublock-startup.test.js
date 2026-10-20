const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const vm = require("node:vm")
const { adaptGeckoUblock, optimizeStorage, optimizeStart } = require("../../../scripts/adapt-gecko-ublock")

const root = path.resolve(__dirname, "../../../vendor/extensions/ublock-origin")
const upstream = fs.readFileSync(path.join(root, "js/storage.js"), "utf8")
const optimized = optimizeStorage(upstream)
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function restoreHarness() {
  const requests = new Map()
  const destroyed = []
  const resources = deferred()
  const context = vm.createContext({
    µb: { selfieIsInvalid: false, loadRedirectResources: () => { requests.set("resources", resources); return resources.promise } },
    io: { fromCache: key => { const pending = deferred(); requests.set(key, pending); return pending.promise } },
    staticExtFilteringEngine: { fromSelfie: value => value },
    staticNetFilteringEngine: { fromSelfie: value => value },
    startupSelfie: { generation: 0, read: key => { const pending = deferred(); requests.set(key, pending); return pending.promise } },
    loadMain: () => { const pending = deferred(); requests.set("main", pending); return pending.promise },
    destroy: () => destroyed.push(true), ubolog() {}
  })
  const start = optimized.indexOf("    const load = async function() {", optimized.indexOf("const loadMain ="))
  const end = optimized.indexOf("    const destroy =", start)
  vm.runInContext(optimized.slice(start, end) + "globalThis.restore = load;", context)
  return { requests, destroyed, context, restore: context.restore }
}

for (const failure of [null, "invalid", "rejected", "resources-invalid", "resources-rejected"]) {
  test(`filter restoration waits for every task before completion or fallback: ${failure}`, async () => {
    const h = restoreHarness()
    let completed = false
    const result = h.restore().then(value => { completed = true; return value })
    assert.equal(h.requests.size, 4, "redirect resources start alongside static snapshots")
    h.requests.get("main").resolve(failure !== "invalid")
    h.requests.get("selfie/staticExtFilteringEngine").resolve(true)
    const net = h.requests.get("selfie/staticNetFilteringEngine")
    if (failure === "rejected") net.reject(new Error("broken snapshot"))
    else net.resolve(true)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(completed, false, "neither success nor fallback may race unfinished resources")
    if (failure === "resources-rejected") h.requests.get("resources").reject(new Error("unreadable redirect cache"))
    else h.requests.get("resources").resolve(failure !== "resources-invalid")
    assert.equal(await result, failure === null)
    assert.equal(h.destroyed.length, ["invalid", "rejected", "resources-rejected"].includes(failure) ? 1 : 0)
  })
}

test("an already invalid snapshot goes directly to upstream's list-loading fallback", async () => {
  const h = restoreHarness()
  h.context.µb.selfieIsInvalid = true
  assert.equal(await h.restore(), false)
  assert.equal(h.requests.size, 0)
})

function pslHarness({ valid, wasm, disabled = false }) {
  const calls = []
  const context = vm.createContext({
    µb: { hiddenSettings: { disableWebAssembly: disabled }, pslAssetKey: "psl", compilePublicSuffixList: data => calls.push(["compile", data]) },
    publicSuffixList: { enableWASM: () => { calls.push(["wasm"]); return wasm.promise }, fromSelfie: () => valid },
    vAPI: { canWASM: true },
    io: { fromCache: async () => { calls.push(["cache"]); return {} }, get: async () => ({ content: "suffix data" }) },
    ubolog() {}
  })
  const start = optimized.indexOf("µb.loadPublicSuffixList =")
  const end = optimized.indexOf("µb.compilePublicSuffixList =", start)
  vm.runInContext(optimized.slice(start, end), context)
  return { calls, load: () => context.µb.loadPublicSuffixList() }
}

test("PSL data loads while optional WASM is pending, and WASM failure is handled", async () => {
  const wasm = deferred()
  const h = pslHarness({ valid: true, wasm })
  await h.load()
  assert.deepEqual(h.calls, [["wasm"], ["cache"]])
  wasm.reject(new Error("WASM unavailable"))
  await new Promise(resolve => setImmediate(resolve))
})

test("invalid PSL still loads its source and honors disabled WASM", async () => {
  const h = pslHarness({ valid: false, wasm: deferred(), disabled: true })
  await h.load()
  assert.deepEqual(h.calls, [["cache"], ["compile", "suffix data"]])
})

test("Android adaptation preserves identity, permissions, barrier code and upstream signed source", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "once-ubo-"))
  try {
    const target = path.join(dir, "ublock")
    assert.equal(adaptGeckoUblock(root, target, "upstream-pin"), true)
    assert.equal(adaptGeckoUblock(root, target, "upstream-pin"), false)
    const before = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")))
    const after = JSON.parse(fs.readFileSync(path.join(target, "manifest.json")))
    assert.match(after.version, /^1\.74\.0\.\d+$/)
    assert.equal(after.version_name, before.version_name || before.version)
    assert.equal(/^\d+\.\d+\.\d+\D/.test(after.version_name), false, "do not accidentally enable uBlock development defaults")
    if (before.version_name === undefined) delete after.version_name
    after.version = before.version
    assert.deepEqual(after, before)
    for (const file of ["js/traffic.js", "js/cachestorage.js"]) {
      assert.deepEqual(fs.readFileSync(path.join(target, file)), fs.readFileSync(path.join(root, file)))
    }
    const originalStart = fs.readFileSync(path.join(root, "js/start.js"), "utf8")
    const barrier = originalStart.indexOf("// Prime the filtering engines")
    const adaptedStart = optimizeStart(originalStart)
    assert.equal(adaptedStart.slice(adaptedStart.indexOf("// Prime the filtering engines")), originalStart.slice(barrier))
    assert.equal(fs.existsSync(path.join(target, "META-INF")), false, "do not claim upstream's signature covers changed files")
    assert.equal(fs.existsSync(path.join(root, "META-INF/mozilla.rsa")), true)
    assert.equal(fs.readFileSync(path.join(root, "js/storage.js"), "utf8"), upstream)
    assert.throws(() => optimizeStorage(upstream.replace("const loadMain", "const renamedLoadMain").replace("                loadMain(),", "                renamedLoadMain(),")), /review/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const { batchStartupAdminStorage } = require("../../../scripts/gecko-ublock-startup")

test("startup admin subsets share one read, preserve defaults and isolate callers, then restore live reads", async () => {
  let reads = 0
  const source = { hidden: { enabled: true }, flag: false, empty: 0 }
  const storage = { async get(key) { reads++; assert.equal(key, null); return source } }
  const original = storage.get
  const restore = batchStartupAdminStorage(storage)
  const [hidden, flags, all] = await Promise.all([storage.get("hidden"), storage.get(["flag", "missing"]), storage.get()])
  hidden.enabled = false
  assert.equal(all.hidden.enabled, true)
  assert.deepEqual(flags, { flag: false })
  assert.deepEqual(await storage.get({ empty: 10, missing: 42 }), { empty: 0, missing: 42 })
  assert.equal(reads, 1)
  restore()
  assert.equal(storage.get, original)
  await storage.get(null)
  assert.equal(reads, 2)
})

test("missing managed storage and failed reads retain their result and restoration", async () => {
  for (const fail of [false, true]) {
    const original = async () => { if (fail) throw new Error("unavailable"); return undefined }
    const storage = { get: original }
    const restore = batchStartupAdminStorage(storage)
    try {
      if (fail) await assert.rejects(storage.get("key"), /unavailable/)
      else assert.equal(await storage.get("key"), undefined)
    } finally { restore() }
    assert.equal(storage.get, original)
  }
})

const { prefetchStartupSelfie } = require("../../../scripts/gecko-ublock-startup")

test("prefetch overlaps settings without applying data, and each record is consumed once", async () => {
  const calls = []
  const io = { fromCache: async key => { calls.push(key); return { key } } }
  const cache = prefetchStartupSelfie(io, () => false)
  cache.prepare(); cache.prepare()
  assert.equal(calls.length, 3)
  assert.deepEqual(await cache.read("selfie/staticMain"), { key: "selfie/staticMain" })
  assert.equal(calls.length, 3)
  await cache.read("selfie/staticMain")
  assert.equal(calls.length, 4, "consumed data must not become a persistent cache")
})

test("invalidation while a prefetched record is being read discards it", async () => {
  const pending = deferred()
  const cache = prefetchStartupSelfie({ fromCache: () => pending.promise }, () => false)
  cache.prepare()
  const read = cache.read("selfie/staticMain")
  cache.invalidate()
  pending.resolve({ old: true })
  assert.equal(await read, undefined)
  assert.equal(cache.generation, 1)
})

test("invalid or failed speculative snapshots remain cache misses without unhandled rejections", async () => {
  let invalid = true, reads = 0
  const cache = prefetchStartupSelfie({ fromCache: async () => { reads++; throw new Error("missing") } }, () => invalid)
  cache.prepare()
  assert.equal(reads, 0)
  invalid = false
  cache.prepare()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await cache.read("selfie/staticMain"), undefined)
  invalid = true
  assert.equal(await cache.read("selfie/staticNetFilteringEngine"), undefined)
})

test("snapshot invalidation during restoration cannot report readiness", async () => {
  const h = restoreHarness()
  const result = h.restore()
  for (const request of h.requests.values()) request.resolve(true)
  h.context.startupSelfie.generation++
  assert.equal(await result, false)
  assert.equal(h.destroyed.length, 1)
})
