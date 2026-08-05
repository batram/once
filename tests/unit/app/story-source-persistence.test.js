const test = require("node:test")
const assert = require("node:assert/strict")
const { AppSettings } = require("../../../packages/app/dist/AppSettings")

const tick = () => new Promise((resolve) => setImmediate(resolve))
const remote = { version: 2, groups: [], sources: [
  { id: "src_00000001", url: "https://news.ycombinator.com/" }
] }

function harness(initial = {}, configured = false) {
  const values = new Map(Object.entries(initial))
  const diagnostics = []; const events = []; let settingsReplicated
  const syncService = configured ? {
    onSettingsReplicated(handler) { settingsReplicated = handler; return () => {} },
    syncFrom() {}
  } : undefined
  const settings = new AppSettings(
    { get: async (id, fallback) => values.has(id) ? values.get(id) : fallback,
      set: async (id, value) => values.set(id, structuredClone(value)) },
    { getSyncUrl: async () => configured ? "https://sync.example/db" : "",
      setSyncUrl: async () => {}, getCacheTime: async () => 120, setCacheTime: async () => {} },
    syncService, { setTheme() {} }, {
      publishChanged: (section) => events.push(section),
      reportDiagnostic: (error) => diagnostics.push(error), reloadStories: () => events.push("reload"),
      refilterStories() {}, refreshRedirects() {}, updateSourceMenu() {}, loadedStoryIds: () => []
    })
  return { settings, values, diagnostics, events,
    replicate: () => settingsReplicated?.() }
}

test("local-only startup persists typed defaults immediately", async () => {
  const h = harness()
  await h.settings.startSync("")
  assert.equal(h.values.get("sources").version, 2)
  assert.equal((await h.settings.getStorySources()).sources.length, 5)
})

test("configured sync serves typed defaults without persisting until settings replicate", async () => {
  const h = harness({}, true)
  await h.settings.startSync("https://sync.example/db")
  assert.equal((await h.settings.getStorySources()).sources.length, 5)
  assert.equal(h.values.has("sources"), false)
  h.replicate(); await tick()
  assert.equal(h.values.has("sources"), true)
})

test("an observed sources write cannot resolve before settings replicate", async () => {
  const h = harness({}, true)
  await h.settings.startSync("https://sync.example/db")
  h.values.set("sources", remote)
  h.settings.handleObservedChange({ id: "sources", doc: { list: remote } })
  await tick()
  assert.equal((await h.settings.getStorySources()).sources.length, 5)
  h.replicate(); await tick()
  assert.deepEqual(await h.settings.getStorySources(), remote)
})

test("a delayed remote sources document wins when replication completes", async () => {
  const h = harness({}, true)
  await h.settings.startSync("https://sync.example/db")
  h.values.set("sources", remote)
  h.replicate(); await tick()
  assert.deepEqual(await h.settings.getStorySources(), remote)
})

test("malformed sources is never overwritten by typed defaults", async () => {
  const malformed = { version: 99, groups: [], sources: [] }
  const h = harness({ sources: malformed }, true)
  await h.settings.startSync("https://sync.example/db"); h.replicate(); await tick()
  assert.deepEqual(h.values.get("sources"), malformed)
  assert.equal(h.diagnostics.at(-1).operation, "settings.load.sources")

  h.values.set("sources", remote)
  h.settings.handleObservedChange({ id: "sources", doc: { list: remote } })
  await tick()
  assert.deepEqual(await h.settings.getStorySources(), remote)
})
