const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const fixtures = require("../../fixtures/extensions/portable-filters.json")
const root = path.resolve(__dirname, "../../..")
const context = vm.createContext({})
vm.runInContext(fs.readFileSync(path.join(root, "apps/mobile/extensions/once-surface/filterRules.js"), "utf8"), context)

for (const fixture of fixtures) {
  test(`portable filters: ${fixture.name}`, () => {
    const parsed = context.onceFilterRules.parse(fixture.list)
    assert.equal(!parsed.allowed.some(rule => rule.test(fixture.url)) && parsed.blocked.some(rule => rule.test(fixture.url)), fixture.blocked)
    assert.equal(parsed.skipped, fixture.skipped)
    if (fixture.selectors) assert.deepEqual(Array.from(parsed.selectors), fixture.selectors)
  })
}

test("Android settings discard an old download before committing newer rules", async () => {
  let receive, request
  const downloads = []
  const bridge = vm.createContext({
    console: { info() {}, error(error) { throw error } },
    fetch: url => new Promise(resolve => downloads.push({ url, resolve })),
    browser: {
      runtime: { connectNative: () => ({ onMessage: { addListener: listener => { receive = listener } } }) },
      contentScripts: { register: async () => ({ unregister: async () => {} }) },
      webRequest: { onBeforeRequest: { addListener: listener => { request = listener } } }
    }
  })
  for (const file of ["filterRules.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "apps/mobile/extensions/once-surface", file), "utf8"), bridge)
  }
  const send = url => receive({ type: "extension-settings", value: {
    filterLists: { lists: [{ url, enabled: true }] }, userscripts: { scripts: [] }
  } })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  send("https://lists.test/old")
  await tick()
  send("https://lists.test/new")
  downloads[0].resolve({ ok: true, text: async () => "||old.test^" })
  await tick()
  assert.equal(request({ url: "https://old.test/banner" }).cancel, undefined)
  assert.equal(downloads[1].url, "https://lists.test/new")
  downloads[1].resolve({ ok: true, text: async () => "||new.test^" })
  await tick()
  assert.equal(request({ url: "https://new.test/banner" }).cancel, true)
  assert.equal(request({ url: "https://old.test/banner" }).cancel, undefined)
})
