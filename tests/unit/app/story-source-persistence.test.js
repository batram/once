const test = require("node:test")
const assert = require("node:assert/strict")
const { AppSettings } = require("../../../packages/app/dist/AppSettings")

const tick = () => new Promise((resolve) => setImmediate(resolve))
const legacy = ["https://old.reddit.com/r/test/.rss"]
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

test("local-only startup migrates immediately to sources", async () => {
  const h = harness({ story_sources: legacy })
  await h.settings.startSync("")
  assert.equal(h.values.get("sources").version, 2)
  assert.equal((await h.settings.getStorySources()).sources[0].url, legacy[0])
})

test("configured sync serves legacy without persisting until settings replicate", async () => {
  const h = harness({ story_sources: legacy }, true)
  await h.settings.startSync("https://sync.example/db")
  assert.equal((await h.settings.getStorySources()).sources[0].url, legacy[0])
  assert.equal(h.values.has("sources"), false)
  h.replicate(); await tick()
  assert.equal(h.values.has("sources"), true)
})

test("an observed sources write cannot resolve before settings replicate", async () => {
  const h = harness({ story_sources: legacy }, true)
  await h.settings.startSync("https://sync.example/db")
  h.values.set("sources", remote)
  h.settings.handleObservedChange({ id: "sources", doc: { list: remote } })
  await tick()
  assert.equal((await h.settings.getStorySources()).sources[0].url, legacy[0])
  h.replicate(); await tick()
  assert.deepEqual(await h.settings.getStorySources(), remote)
})

test("a delayed remote sources document wins when replication completes", async () => {
  const h = harness({ story_sources: legacy }, true)
  await h.settings.startSync("https://sync.example/db")
  h.values.set("sources", remote)
  h.replicate(); await tick()
  assert.deepEqual(await h.settings.getStorySources(), remote)
})

test("both documents keep sources authoritative and diagnose a digest mismatch", async () => {
  const h = harness({ story_sources: legacy, sources: {
    ...remote, migratedFrom: { docId: "story_sources", digest: "deadbeef" }
  } }, true)
  await h.settings.startSync("https://sync.example/db"); h.replicate(); await tick()
  assert.equal((await h.settings.getStorySources()).sources[0].id, "src_00000001")
  assert.equal(h.diagnostics.at(-1).operation, "settings.sources.legacy-diverged")
})

test("malformed sources is never overwritten by legacy migration", async () => {
  const malformed = { version: 99, groups: [], sources: [] }
  const h = harness({ story_sources: legacy, sources: malformed }, true)
  await h.settings.startSync("https://sync.example/db"); h.replicate(); await tick()
  assert.deepEqual(h.values.get("sources"), malformed)
  assert.equal(h.diagnostics.at(-1).operation, "settings.load.sources")
})

test("a post-cutover legacy edit is diagnosed rather than merged", async () => {
  const h = harness({ story_sources: legacy })
  await h.settings.startSync("")
  h.values.set("story_sources", ["https://example.com/changed"])
  h.settings.handleObservedChange({ id: "story_sources", doc: { list: h.values.get("story_sources") } })
  await tick()
  assert.equal(h.diagnostics.at(-1).operation, "settings.sources.legacy-diverged")
  assert.equal((await h.settings.getStorySources()).sources[0].url, legacy[0])
})
