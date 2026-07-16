const test = require("node:test")
const assert = require("node:assert/strict")
const { createOnceApp } = require("../../../packages/app/dist")
const { Story } = require("../../../packages/core/dist")
const { createFakePlatform } = require("../../helpers/fake-platform")

test("routes search links internally and normal links to the active-tab port", () => {
  const fake = createFakePlatform()
  const app = createOnceApp(fake.ports)
  const searches = []
  app.client.subscribe("searchRequested", ({ query }) => searches.push(query))
  app.client.openUrl("search:*security", "_self")
  app.client.openUrl("https://example.com/", "blank")
  assert.deepEqual(searches, ["*security"])
  assert.deepEqual(fake.opened, [{ url: "https://example.com/", target: "blank" }])
})

test("starts from stored stories and persists story changes", async () => {
  const story = new Story("rss", "https://example.com/story", "A story", "https://example.com/comments", Date.now())
  const fake = createFakePlatform([story])
  const app = createOnceApp(fake.ports)
  const changes = []
  app.client.subscribe("storyChanged", (change) => changes.push(change))
  await app.start()
  const saved = await app.client.persistStoryChange(story.href, "read_state", "read")
  assert.equal(saved.read_state, "read")
  assert.equal(changes.at(-1).path[1], "read_state")
  assert.equal(changes.at(-1).value, "read")
})

test("persists rapid changes to one story in interaction order", async () => {
  const story = new Story("rss", "https://example.com/story", "A story")
  const fake = createFakePlatform([story])
  const savedStates = []
  let releaseFirstSave
  const firstSaveBlocked = new Promise((resolve) => { releaseFirstSave = resolve })
  let saveCount = 0
  fake.ports.storyStore.saveStory = async (savedStory) => {
    savedStates.push(savedStory.read_state)
    saveCount += 1
    if (saveCount === 1) await firstSaveBlocked
    return savedStory
  }
  const app = createOnceApp(fake.ports)
  await app.start()

  const markRead = app.client.persistStoryChange(story.href, "read_state", "read")
  const markSkipped = app.client.persistStoryChange(story.href, "read_state", "skipped")
  //the in-memory story updates optimistically while saves are still queued
  assert.equal((await app.client.findStoryByUrl(story.href)).read_state, "skipped")
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(savedStates, ["read"])

  releaseFirstSave()
  await Promise.all([markRead, markSkipped])
  assert.deepEqual(savedStates, ["read", "skipped"])
  assert.equal((await app.client.findStoryByUrl(story.href)).read_state, "skipped")
})

test("ignores stale story echoes from the database changes feed", async () => {
  const story = new Story("rss", "https://example.com/story", "A story")
  story.read_state = "skipped"
  story._rev = "3-current"
  const fake = createFakePlatform([story])
  const app = createOnceApp(fake.ports)
  await app.start()

  fake.emitDatabaseChange({
    id: `sto_${story.href}`,
    doc: { ...story.to_obj(), _rev: "2-stale", read_state: "read" }
  })
  assert.equal((await app.client.findStoryByUrl(story.href)).read_state, "skipped")

  fake.emitDatabaseChange({
    id: `sto_${story.href}`,
    doc: { ...story.to_obj(), _rev: "4-newer", read_state: "read" }
  })
  assert.equal((await app.client.findStoryByUrl(story.href)).read_state, "read")
})

test("rejects empty new stories and does not index empty comment URLs", async () => {
  assert.throws(() => new Story(), /Story is missing required type/)
  assert.throws(() => Story.from_obj({}), /Story is missing required type/)

  const story = new Story("rss", "https://example.com/no-comments", "No comments")
  const fake = createFakePlatform([story])
  const app = createOnceApp(fake.ports)
  await app.start()

  assert.equal(await app.client.findStoryByUrl(""), null)
})

test("finds a story by its rewritten redirect url", async () => {
  const story = new Story("rss", "https://old.example.com/story", "Redirected story")
  const fake = createFakePlatform([story])
  const app = createOnceApp(fake.ports)
  await app.start()

  await app.client.saveRedirectList([
    { match_url: "^https://old\\.example\\.com", replace_url: "https://new.example.com" }
  ])

  const found = await app.client.findStoryByUrl("https://new.example.com/story")
  assert.equal(found?.href, story.href)

  await app.client.saveRedirectList([])
  assert.equal(await app.client.findStoryByUrl("https://new.example.com/story"), null)
})

test("publishes settings, database, reload, and history events", async () => {
  const fake = createFakePlatform()
  const app = createOnceApp(fake.ports)
  const settings = []
  const sourceErrors = []
  const history = []
  app.client.subscribe("settingsChanged", ({ section }) => settings.push(section))
  app.client.subscribe("sourceErrorsChanged", ({ errors }) => sourceErrors.push(errors))
  app.client.subscribe("historyCommand", ({ action }) => history.push(action))
  await app.start()
  await app.client.saveStorySources(["https://invalid.example/unknown"])
  fake.emitDatabaseChange({ id: "theme", doc: { list: "light" } })
  fake.emitHistory("undo")
  assert.ok(settings.includes("sources"))
  assert.ok(settings.includes("theme"))
  assert.equal(sourceErrors.at(-1)[0].title, "No Handler")
  assert.deepEqual(history, ["undo"])
})
