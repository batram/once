const test = require("node:test")
const assert = require("node:assert/strict")
const { createOnceApp } = require("../../../packages/app/dist")
const { createFakePlatform } = require("../../helpers/fake-platform")

const SCRIPT = `// ==UserScript==
// @name  Probe
// @namespace once.test
// @match https://a.test/*
// ==/UserScript==
probe()`

test("extension settings start empty, save normalized, and announce every change", async () => {
  const fake = createFakePlatform()
  const app = createOnceApp(fake.ports)
  const announced = []
  const sections = []
  app.client.subscribe("extensionSettingsChanged", (settings) => announced.push(settings))
  app.client.subscribe("settingsChanged", ({ section }) => sections.push(section))
  await app.start()

  // Startup publishes the (empty) documents once for whatever runs extensions.
  assert.equal(announced.length, 1)
  assert.deepEqual(announced[0].filterLists.lists, [])
  assert.deepEqual(announced[0].userscripts.scripts, [])

  await app.client.saveFilterLists({
    version: 1,
    lists: [{ url: "https://easylist.to/easylist/easylist.txt", enabled: true }, { url: "nope", enabled: true }]
  })
  const lists = await app.client.getFilterLists()
  assert.deepEqual(lists.lists, [{ url: "https://easylist.to/easylist/easylist.txt", enabled: true }])
  assert.deepEqual(announced.at(-1).filterLists, lists)
  assert.equal(sections.at(-1), "extensions")

  await app.client.saveUserscripts({ version: 1, scripts: [{ source: SCRIPT, enabled: false }] })
  const scripts = await app.client.getUserscripts()
  assert.equal(scripts.scripts.length, 1)
  assert.equal(scripts.scripts[0].name, "Probe")
  assert.equal(scripts.scripts[0].enabled, false)
  assert.match(scripts.scripts[0].id, /^usc_/)
  assert.deepEqual(announced.at(-1).userscripts, scripts)
  assert.equal(announced.length, 3)
})

test("a replicated document from another client is announced without a local save", async () => {
  const fake = createFakePlatform()
  const app = createOnceApp(fake.ports)
  const announced = []
  app.client.subscribe("extensionSettingsChanged", (settings) => announced.push(settings))
  await app.start()

  await fake.ports.listStore.set("filter_lists", {
    version: 1,
    lists: [{ url: "https://example.test/list.txt", enabled: false }]
  })
  fake.emitDatabaseChange({ id: "filter_lists" })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(announced.at(-1).filterLists.lists, [
    { url: "https://example.test/list.txt", enabled: false }
  ])
})
