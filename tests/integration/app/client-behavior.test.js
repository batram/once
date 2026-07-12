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

test("rejects empty new stories and does not index empty comment URLs", async () => {
  assert.throws(() => new Story(), /Story is missing required type/)
  assert.throws(() => Story.from_obj({}), /Story is missing required type/)

  const story = new Story("rss", "https://example.com/no-comments", "No comments")
  const fake = createFakePlatform([story])
  const app = createOnceApp(fake.ports)
  await app.start()

  assert.equal(await app.client.findStoryByUrl(""), null)
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
