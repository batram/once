const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { startTestServer } = require("../../e2e/mobile/test-server-process")
const fixtures = require("../../fixtures/extensions/portable-filters.json")
const root = path.resolve(__dirname, "../../..")
const context = vm.createContext({ URL })
vm.runInContext(fs.readFileSync(path.join(root, "apps/mobile/extensions/once-surface/filterRules.js"), "utf8"), context)

for (const fixture of fixtures) {
  test(`portable filters: ${fixture.name}`, () => {
    const parsed = context.onceFilterRules.parse(fixture.list)
    assert.equal(!parsed.allowed.some(rule => rule.test(fixture.url)) && parsed.blocked.some(rule => rule.test(fixture.url)), fixture.blocked)
    assert.equal(parsed.skipped, fixture.skipped)
    if (fixture.selectors) assert.deepEqual(Array.from(parsed.selectors), fixture.selectors)
  })
}

// The native messaging port as the bridge sees it: the host's settings arrive
// through onMessage, and the bridge acknowledges applying them.
function nativePort(onListener, acks) {
  return {
    onMessage: { addListener: onListener },
    onDisconnect: { addListener() {} },
    postMessage: message => acks.push(message)
  }
}

test("mobile smoke filter list blocks its image through the Android bridge", async t => {
  const server = startTestServer({ port: 0, host: "127.0.0.1", stdout: "ignore", stderr: "pipe" })
  t.after(() => server.stop())
  const { port } = await server.ready
  const baseUrl = `http://127.0.0.1:${port}`
  let receive, request
  const css = []
  const errors = []
  const acks = []
  const bridge = vm.createContext({
    fetch, URL,
    console: { info() {}, error(...details) { errors.push(details) } },
    browser: {
      runtime: { connectNative: () => nativePort(listener => { receive = listener }, acks) },
      contentScripts: { register: async registration => {
        css.push(...(registration.css || []).map(entry => entry.code))
        return { unregister: async () => {} }
      } },
      webRequest: { onBeforeRequest: { addListener: listener => { request = listener } } }
    }
  })
  for (const file of ["filterRules.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "apps/mobile/extensions/once-surface", file), "utf8"), bridge)
  }
  receive({ type: "extension-settings", revision: 3, value: {
    filterLists: { lists: [{ url: `${baseUrl}/fixtures/mobile-filter-list.txt`, enabled: true }] },
    userscripts: { scripts: [] }
  } })
  await vm.runInContext("settingsQueue", bridge)
  assert.deepEqual(errors, [])
  // The host holds its first page for this acknowledgement.
  assert.deepEqual(acks.map(ack => [ack.type, ack.revision]), [["extension-settings-applied", 3]])
  assert.equal(request({ url: `${baseUrl}/fixtures/blocked-ad.png` }).cancel, true)
  assert.equal(request({ url: `${baseUrl}/fixtures/article.html` }).cancel, undefined)
  assert.equal(request({ url: `${baseUrl}/fixtures/blocked-ad.png.allowed` }).cancel, undefined)
  assert.ok(css.some(code => code.includes(".once-filter-hide")))
  // A working image endpoint keeps the native onerror probe from passing on a 404.
  const image = await fetch(`${baseUrl}/fixtures/blocked-ad.png`)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get("content-type"), "image/png")
  assert.ok((await image.arrayBuffer()).byteLength > 0)
})

test("Android settings discard an old download before committing newer rules", async () => {
  let receive, request
  const downloads = []
  const acks = []
  const bridge = vm.createContext({
    URL,
    console: { info() {}, error(error) { throw error } },
    fetch: url => new Promise(resolve => downloads.push({ url, resolve })),
    browser: {
      runtime: { connectNative: () => nativePort(listener => { receive = listener }, acks) },
      contentScripts: { register: async () => ({ unregister: async () => {} }) },
      webRequest: { onBeforeRequest: { addListener: listener => { request = listener } } }
    }
  })
  for (const file of ["filterRules.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "apps/mobile/extensions/once-surface", file), "utf8"), bridge)
  }
  const send = (url, revision) => receive({ type: "extension-settings", revision, value: {
    filterLists: { lists: [{ url, enabled: true }] }, userscripts: { scripts: [] }
  } })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  send("https://lists.test/old", 1)
  await tick()
  send("https://lists.test/new", 2)
  downloads[0].resolve({ ok: true, text: async () => "||old.test^" })
  await tick()
  assert.equal(request, undefined, "Obsolete lists must not register any blocking listener")
  assert.equal(downloads[1].url, "https://lists.test/new")
  downloads[1].resolve({ ok: true, text: async () => "||new.test^" })
  await tick()
  assert.equal(request({ url: "https://new.test/banner" }).cancel, true)
  assert.equal(request({ url: "https://old.test/banner" }).cancel, undefined)
  // Only the settings that took effect are acknowledged.
  assert.deepEqual(acks.map(ack => ack.revision), [2])
})

test("indexed filters preserve the linear matcher's decisions across anchors and exceptions", () => {
  const sources = ["||ads.example^", "||sub.ads.example/path", "||ads.example", "||ads.example|", "banner*pixel", "|https://exact.example/x|", "foo^bar", "foo^*^", "||ads.example^*.js"]
  const urls = ["https://ads.example", "https://ads.example/", "https://sub.ads.example/path", "https://ads.example.evil/", "https://ADS.EXAMPLE:8443/a.js", "https://other.example/banner/123pixel", "https://exact.example/x", "https://other.example/foo/bar", "https://sub.ads.example@other.example/a", "https://other.example/foo", "ftp://ads.example/a", "not a url"]
  for (const source of sources) {
    const parsed = context.onceFilterRules.parse(source)
    const matches = context.onceFilterRules.matcher(parsed.blocked)
    for (const url of urls) assert.equal(matches(url), parsed.blocked.some(rule => rule.test(url)), `${source}: ${url}`)
  }
  const parsed = context.onceFilterRules.parse("||ads.example^\n@@||safe.ads.example^\n@@allowed-banner")
  const blocks = context.onceFilterRules.matcher(parsed.blocked), allows = context.onceFilterRules.matcher(parsed.allowed)
  assert.equal(blocks("https://ads.example/banner") && !allows("https://ads.example/banner"), true)
  assert.equal(blocks("https://safe.ads.example/banner") && !allows("https://safe.ads.example/banner"), false)
  assert.equal(blocks("https://ads.example/allowed-banner") && !allows("https://ads.example/allowed-banner"), false)
})

test("10,000 unrelated domain rules require no regex tests for an unrelated host", () => {
  const parsed = context.onceFilterRules.parse(Array.from({ length: 10000 }, (_, i) => `||host-${i}.example^`).join("\n"))
  let tested = 0
  for (const rule of parsed.blocked) {
    const original = rule.test.bind(rule)
    rule.test = url => { tested++; return original(url) }
  }
  const matches = context.onceFilterRules.matcher(parsed.blocked)
  assert.equal(matches("https://unrelated.example/article"), false)
  assert.equal(tested, 0)
  assert.equal(matches("https://sub.host-4321.example/article"), true)
  assert.equal(tested, 1)
})

test("empty and cosmetic-only settings remove the listener; failed updates preserve working rules", async () => {
  let receive, request
  let added = 0, removed = 0
  let text = "||ads.example^", fails = false
  const acks = [], errors = []
  const bridge = vm.createContext({ URL,
    fetch: async () => { if (fails) throw new Error("offline"); return { ok: true, text: async () => text } },
    console: { info() {}, error(...message) { errors.push(message) } },
    browser: {
      runtime: { connectNative: () => nativePort(listener => { receive = listener }, acks) },
      contentScripts: { register: async () => ({ unregister: async () => {} }) },
      webRequest: { onBeforeRequest: {
        addListener(listener) { assert.equal(request, undefined); added++; request = listener },
        removeListener(listener) { assert.equal(request, listener); removed++; request = undefined }
      } }
    }
  })
  for (const file of ["filterRules.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(root, "apps/mobile/extensions/once-surface", file), "utf8"), bridge)
  const apply = async lists => {
    receive({ type: "extension-settings", revision: acks.length + 1, value: { filterLists: { lists }, userscripts: { scripts: [] } } })
    await vm.runInContext("settingsQueue", bridge)
  }
  const list = [{ url: "https://lists.example/rules", enabled: true }]
  await apply([]); assert.equal(added, 0)
  await apply(list); assert.equal(added, 1)
  assert.equal(request({ url: "https://ads.example/a" }).cancel, true)
  fails = true; await apply(list)
  assert.equal(errors.length, 1)
  assert.equal(request({ url: "https://ads.example/a" }).cancel, true)
  fails = false; text = "##.advert"; await apply(list)
  assert.equal(request, undefined); assert.equal(removed, 1)
  text = "||ads.example^"; await apply(list)
  assert.equal(added, 2)
  await apply([]); assert.equal(request, undefined); assert.equal(removed, 2)
})
