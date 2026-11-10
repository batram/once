const test = require("node:test")
const assert = require("node:assert/strict")
const { AppRuntime } = require("../../../packages/app/dist/AppRuntime")
const { Story } = require("../../../packages/core/dist")
const { createFakePlatform } = require("../../helpers/fake-platform")

function fixture() {
  const story = new Story("RSS", "https://example.test/story", "Example")
  const fake = createFakePlatform([story]), app = new AppRuntime(fake.ports)
  const originalSave = fake.ports.storyStore.saveStory
  const writes = []
  fake.ports.storyStore.saveStory = async (value, options) => { writes.push({ value: value.to_obj(), options }); return originalSave(value) }
  // The app's own copy: a real store hands out a new object for every read.
  const working = () => app.client.getStorySnapshot()[0]
  return { story, fake, app, writes, working }
}

test("repeating the current user state never stamps a clock or saves", async () => {
  const { story, app, writes, working } = fixture()
  await app.client.persistStoryChange(story.href, "read_state", "unread")
  assert.equal(writes.length, 0); assert.equal(working().sync_updated_at, undefined)
  await app.client.persistStoryChange(story.href, "stared", true)
  const clock = working().sync_updated_at.stared
  await app.client.persistStoryChange(story.href, "stared", true)
  assert.equal(writes.length, 1); assert.equal(working().sync_updated_at.stared, clock)
  await app.client.persistStoryChange(story.href, "stared", false)
  await app.client.persistStoryChange(story.href, "stared", true)
  assert.equal(writes.length, 3); assert.ok(working().sync_updated_at.stared > clock)
})

test("failed optimistic actions can be retried with the same requested value", async t => {
  t.mock.method(console, "error", () => {})
  const { story, fake, app, working } = fixture()
  const save = fake.ports.storyStore.saveStory
  fake.ports.storyStore.saveStory = async () => { throw Error("failed write") }
  await assert.rejects(app.client.persistStoryChange(story.href, "stared", true), /failed write/)
  assert.equal(working().stared, false)
  fake.ports.storyStore.saveStory = save
  await app.client.persistStoryChange(story.href, "stared", true)
  assert.equal((await fake.ports.storyStore.getStory(story.href)).stared, true)
})

test("automatic re-filtering writes only changed values, without a device clock", async () => {
  const { app, writes, working } = fixture()
  await app.client.getStories()
  await app.settings.saveFilterList(["Example"])
  assert.equal(writes.length, 1)
  assert.equal(writes[0].value.filter, "Example")
  assert.equal(writes[0].value.sync_updated_at?.filter, 0)
  assert.deepEqual(writes[0].options, { derivedFilter: true })
  await app.settings.saveFilterList(["Example"])
  assert.equal(writes.length, 1)
  await app.settings.saveFilterList([])
  assert.equal(writes.length, 2); assert.equal(writes[1].value.filter, "")
  assert.equal(working().sync_updated_at?.filter, 0)
})
