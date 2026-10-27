const test = require("node:test")
const assert = require("node:assert/strict")
const { AppRuntime } = require("../../../packages/app/dist/AppRuntime")
const { Story } = require("../../../packages/core/dist")
const { createFakePlatform } = require("../../helpers/fake-platform")

function fixture() {
  const stored = new Story("rss", "https://example.com/part", "Part 14", "", 1, "RT ")
  stored.read_state = "skipped"
  stored.sync_updated_at = { filter: 100, read_state: 200 }
  const fake = createFakePlatform([stored])
  return { stored, fake, app: new AppRuntime(fake.ports) }
}

test("rules edited before a saved story is ingested apply to the retained story", async () => {
  const { stored, fake, app } = fixture()
  await app.client.saveFilterList(["RT @"])
  await app.processStoryInput([new Story("rss", stored.href, stored.title, "", 1)], "Default")
  const result = app.client.getStorySnapshot()[0]
  assert.equal(result.filter, "")
  assert.equal(result.read_state, "skipped")
  assert.equal(result.sync_updated_at.filter, 0)
  assert.equal(result.sync_updated_at.read_state, 200)
  const restarted = new AppRuntime(fake.ports)
  assert.equal((await restarted.client.getStories())[0].filter, "")
})

test("saved story loads evaluate current rules without writing old records", async () => {
  const { stored, fake, app } = fixture()
  await app.client.saveFilterList(["RT @"])
  let writes = 0
  fake.ports.storyStore.saveStory = async () => { writes++; throw new Error("unexpected write") }
  assert.equal((await app.client.getStories())[0].filter, "")
  assert.equal(stored.filter, "RT ")
  assert.equal(writes, 0)
  const other = new AppRuntime(fake.ports)
  assert.equal((await other.findStoryByUrl(stored.href)).filter, "")
  assert.equal(writes, 0)
})

test("startup bookmarks and newly matching saved stories use current rules", async () => {
  const { stored, app } = fixture()
  stored.stared = true
  await app.client.saveFilterList(["Part"])
  await app.start()
  assert.equal(app.client.getStorySnapshot()[0].filter, "Part")
  assert.equal(app.client.getStorySnapshot()[0].stared, true)
})

for (const kind of ["observed", "remote"]) {
  test(`${kind} updates cannot restore obsolete filters`, async () => {
    const { stored, fake, app } = fixture()
    await app.client.saveFilterList(["RT @"])
    await app.client.getStories()
    const changed = Story.from_obj({ ...stored.to_obj(), _rev: "2-new", read_state: "read", sync_updated_at: { filter: 500, read_state: 300 } })
    fake.setStoredStory(changed)
    await app.reconciler[kind]({ id: `sto_${stored.href}`, doc: changed.to_obj(), presentation: "foreground" })
    const result = app.client.getStorySnapshot()[0]
    assert.equal(result.filter, "")
    assert.equal(result.read_state, "read")
  })
}

test("foreground sync filters new working stories but background sync stays bounded", async () => {
  const { stored, app } = fixture()
  await app.client.saveFilterList(["RT @"])
  const change = { id: `sto_${stored.href}`, doc: stored.to_obj(), presentation: "background" }
  await app.reconciler.remote(change)
  assert.equal(app.client.getStorySnapshot().length, 0)
  await app.reconciler.remote({ ...change, presentation: "foreground" })
  assert.equal(app.client.getStorySnapshot()[0].filter, "")
})

test("manual filter markers survive loading when no keyword matches", async () => {
  const { stored, app } = fixture()
  stored.filter = "::manual"
  await app.client.saveFilterList(["RT @"])
  assert.equal((await app.client.getStories())[0].filter, "::manual")
})
