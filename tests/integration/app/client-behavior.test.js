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
  assert.equal(typeof saved.sync_updated_at.read_state, "number")
  assert.equal(changes.at(-1).path[1], "read_state")
  assert.equal(changes.at(-1).value, "read")
})

test("provides the current loaded-story ids to a new database sync", async () => {
  const story = new Story("rss", "https://example.com/story", "A story")
  const fake = createFakePlatform([story])
  let getLoadedStoryIds
  fake.ports.syncService.syncFrom = (_url, getIds) => {
    getLoadedStoryIds = getIds
  }
  const app = createOnceApp(fake.ports)
  await app.start()

  assert.deepEqual(getLoadedStoryIds(), [])
  await app.client.getStories()
  assert.deepEqual(getLoadedStoryIds(), [`sto_${story.href}`])
})

test("startup restores stared stories without presenting the stored archive", async () => {
  const archived = new Story("rss", "https://example.com/archive", "Archived")
  const stared = new Story("rss", "https://example.com/stared", "Stared")
  stared.stared = true
  const fake = createFakePlatform([archived, stared])
  const app = createOnceApp(fake.ports)

  await app.start()

  assert.deepEqual(app.client.getStorySnapshot().map(({ href }) => href), [
    stared.href
  ])
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
  await app.client.settledStoryWrites()
  await Promise.all([markRead, markSkipped])
  assert.deepEqual(savedStates, ["read", "skipped"])
  assert.equal((await app.client.findStoryByUrl(story.href)).read_state, "skipped")
})

test("keeps a user change made while a remote merge is saving", async () => {
  const story = new Story("rss", "https://example.com/story", "A story")
  story.read_state = "read"
  story.sync_updated_at = { read_state: 100 }
  story._rev = "3-local"
  const fake = createFakePlatform([story])
  const originalSave = fake.ports.storyStore.saveStory
  const savedStates = []
  let releaseRemoteSave
  const remoteSaveBlocked = new Promise((resolve) => {
    releaseRemoteSave = resolve
  })
  fake.ports.storyStore.saveStory = async (savedStory) => {
    savedStates.push(savedStory.read_state)
    if (savedStates.length === 1) await remoteSaveBlocked
    savedStory._rev = `${savedStates.length + 3}-saved`
    return originalSave(savedStory)
  }
  const app = createOnceApp(fake.ports)
  await app.start()
  await app.client.findStoryByUrl(story.href)

  fake.emitRemoteDatabaseChange({
    id: `sto_${story.href}`,
    doc: {
      ...story.to_obj(),
      _rev: "4-remote",
      read_state: "skipped",
      sync_updated_at: { read_state: 200 }
    },
    presentation: "foreground"
  })
  await new Promise((resolve) => setImmediate(resolve))

  const localChange = app.client.persistStoryChange(
    story.href,
    "read_state",
    "unread"
  )
  releaseRemoteSave()
  await localChange
  await app.client.settledStoryWrites()

  assert.deepEqual(savedStates, ["skipped", "unread"])
  assert.equal(
    (await app.client.findStoryByUrl(story.href)).read_state,
    "unread"
  )
})

test("ignores origin-blind story echoes and applies serialized remote changes", async () => {
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
  assert.equal((await app.client.findStoryByUrl(story.href)).read_state, "skipped")

  fake.emitRemoteDatabaseChange({
    id: `sto_${story.href}`,
    doc: {
      ...story.to_obj(),
      _rev: "4-newer",
      read_state: "read",
      sync_updated_at: { read_state: 100 }
    },
    presentation: "foreground"
  })
  await app.client.settledStoryWrites()
  assert.equal((await app.client.findStoryByUrl(story.href)).read_state, "read")
})

test("reconciles a visible story changed by another local app instance", async () => {
  const story = new Story("rss", "https://example.com/story", "A story")
  story.sync_updated_at = { read_state: 100 }
  story._rev = "1-local"
  const fake = createFakePlatform([story])
  const app = createOnceApp(fake.ports)
  await app.start()
  await app.client.findStoryByUrl(story.href)

  const peerStory = Story.from_obj({
    ...story.to_obj(),
    _rev: "2-peer",
    read_state: "read",
    sync_updated_at: { read_state: 200 }
  })
  fake.setStoredStory(peerStory)
  fake.emitDatabaseChange({
    id: `sto_${story.href}`,
    doc: peerStory.to_obj()
  })
  await app.client.settledStoryWrites()

  assert.equal(app.client.getStorySnapshot()[0].read_state, "read")
  assert.equal(app.client.getStorySnapshot()[0]._rev, "2-peer")
})

test("adds foreground remote stories to the working snapshot", async () => {
  const fake = createFakePlatform()
  const app = createOnceApp(fake.ports)
  const additions = []
  app.client.subscribe("storiesChanged", (change) => additions.push(change))
  await app.start()

  const story = new Story("rss", "https://example.com/remote", "Remote story")
  story._rev = "1-remote"
  fake.emitRemoteDatabaseChange({
    id: `sto_${story.href}`,
    doc: story.to_obj(),
    presentation: "foreground"
  })
  await app.client.settledStoryWrites()

  assert.deepEqual(app.client.getStorySnapshot().map(({ href }) => href), [
    story.href
  ])
  assert.deepEqual(additions.map(({ stories }) => stories[0].href), [
    story.href
  ])
})

test("keeps background backfill out of the working snapshot", async () => {
  const fake = createFakePlatform()
  const app = createOnceApp(fake.ports)
  const additions = []
  app.client.subscribe("storiesChanged", (change) => additions.push(change))
  await app.start()

  const story = new Story("rss", "https://example.com/older", "Older story")
  story._rev = "1-remote"
  fake.emitRemoteDatabaseChange({
    id: `sto_${story.href}`,
    doc: story.to_obj(),
    presentation: "background"
  })
  await app.client.settledStoryWrites()

  assert.deepEqual(app.client.getStorySnapshot(), [])
  assert.deepEqual(additions, [])
})

test("applies background backfill updates to an already visible story", async () => {
  const story = new Story("rss", "https://example.com/story", "A story")
  story.sync_updated_at = { read_state: 100 }
  const fake = createFakePlatform([story])
  const app = createOnceApp(fake.ports)
  const changes = []
  app.client.subscribe("storyChanged", (change) => changes.push(change))
  await app.start()
  await app.client.findStoryByUrl(story.href)

  fake.emitRemoteDatabaseChange({
    id: `sto_${story.href}`,
    doc: {
      ...story.to_obj(),
      _rev: "2-remote",
      read_state: "read",
      sync_updated_at: { read_state: 200 }
    },
    presentation: "background"
  })
  await app.client.settledStoryWrites()

  assert.equal(app.client.getStorySnapshot()[0].read_state, "read")
  assert.equal(changes.at(-1).story.read_state, "read")
})

test("removes remotely deleted stories from working state", async () => {
  const story = new Story("rss", "https://example.com/story", "A story")
  const fake = createFakePlatform([story])
  const app = createOnceApp(fake.ports)
  const removals = []
  app.client.subscribe("storyRemoved", (change) => removals.push(change))
  await app.start()
  await app.client.findStoryByUrl(story.href)

  fake.emitRemoteDatabaseChange({
    id: `sto_${story.href}`,
    doc: { _id: `sto_${story.href}`, _rev: "2-deleted", _deleted: true },
    presentation: "foreground"
  })
  await app.client.settledStoryWrites()

  assert.deepEqual(app.client.getStorySnapshot(), [])
  assert.deepEqual(removals, [{ href: story.href }])
})

test("surfaces remote reconciliation failures as diagnostics", async (t) => {
  t.mock.method(console, "error", () => {})

  const fake = createFakePlatform()
  const app = createOnceApp(fake.ports)
  await app.start()

  fake.emitRemoteDatabaseChange({
    id: "sto_invalid",
    doc: { _id: "sto_invalid", read_state: "unread" },
    presentation: "foreground"
  })
  await app.client.settledStoryWrites()

  assert.equal(app.client.getDiagnostics().at(-1).operation, "story.sync")
  assert.match(
    app.client.getDiagnostics().at(-1).message,
    /could not be applied/
  )
})

test("applies a pulled conflicting story state on top of the local winner", async () => {
  const story = new Story("rss", "https://example.com/story", "A story")
  story.read_state = "unread"
  story._rev = "5-local"
  const fake = createFakePlatform([story])
  const savedStates = []
  const saveStory = fake.ports.storyStore.saveStory
  fake.ports.storyStore.saveStory = async (remoteStory) => {
    savedStates.push(remoteStory.read_state)
    remoteStory._rev = "6-merged"
    return saveStory(remoteStory)
  }
  const app = createOnceApp(fake.ports)
  const changes = []
  app.client.subscribe("storyChanged", (change) => changes.push(change))
  await app.start()
  await app.client.findStoryByUrl(story.href)

  fake.emitRemoteDatabaseChange({
    id: `sto_${story.href}`,
    doc: { ...story.to_obj(), _rev: "3-remote", read_state: "skipped" }
  })
  await new Promise((resolve) => setImmediate(resolve))
  await app.client.settledStoryWrites()

  assert.deepEqual(savedStates, ["skipped"])
  assert.equal((await app.client.findStoryByUrl(story.href)).read_state, "skipped")
  assert.equal(changes.at(-1).story.read_state, "skipped")
  assert.equal(changes.at(-1).story._rev, "6-merged")

  fake.emitRemoteDatabaseChange({
    id: `sto_${story.href}`,
    doc: { ...story.to_obj(), _rev: "7-stale", read_state: "unread" }
  })
  await new Promise((resolve) => setImmediate(resolve))
  await app.client.settledStoryWrites()

  assert.deepEqual(savedStates, ["skipped"])
  assert.equal((await app.client.findStoryByUrl(story.href)).read_state, "skipped")
})

test("uses field timestamps to converge story state without repeated writes", async () => {
  const story = new Story("rss", "https://example.com/story", "A story")
  story.read_state = "read"
  story.sync_updated_at = { read_state: 200 }
  story._rev = "5-local"
  const fake = createFakePlatform([story])
  const savedStates = []
  const saveStory = fake.ports.storyStore.saveStory
  fake.ports.storyStore.saveStory = async (mergedStory) => {
    savedStates.push(mergedStory.read_state)
    mergedStory._rev = "6-merged"
    return saveStory(mergedStory)
  }
  const app = createOnceApp(fake.ports)
  await app.start()

  const remote = {
    ...story.to_obj(),
    _rev: "4-remote",
    read_state: "unread",
    sync_updated_at: { read_state: 100 }
  }
  fake.emitRemoteDatabaseChange({ id: `sto_${story.href}`, doc: remote })
  await new Promise((resolve) => setImmediate(resolve))
  await app.client.settledStoryWrites()
  fake.emitRemoteDatabaseChange({ id: `sto_${story.href}`, doc: remote })
  await new Promise((resolve) => setImmediate(resolve))
  await app.client.settledStoryWrites()

  assert.deepEqual(savedStates, [])
  assert.equal((await app.client.findStoryByUrl(story.href)).read_state, "read")
})

test("does not erase newer offline edits during a foreground remote refresh", async () => {
  const story = new Story("rss", "https://example.com/story", "A story")
  story.read_state = "read"
  story.stared = true
  story.filter = "local"
  story.sync_updated_at = {
    read_state: 300,
    stared: 300,
    filter: 300
  }
  story._rev = "3-local"
  const fake = createFakePlatform([story])
  const app = createOnceApp(fake.ports)
  await app.start()

  fake.emitRemoteDatabaseChange({
    id: `sto_${story.href}`,
    doc: {
      ...story.to_obj(),
      _rev: "4-remote",
      read_state: "unread",
      stared: false,
      filter: "",
      sync_updated_at: {
        read_state: 100,
        stared: 100,
        filter: 100
      }
    },
    presentation: "foreground"
  })
  await app.client.settledStoryWrites()

  const accepted = await app.client.findStoryByUrl(story.href)
  assert.equal(accepted.read_state, "read")
  assert.equal(accepted.stared, true)
  assert.equal(accepted.filter, "local")
  assert.deepEqual(accepted.sync_updated_at, {
    read_state: 300,
    stared: 300,
    filter: 300
  })
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
  await app.client.saveStorySources({ version: 2, groups: [], sources: [
    { id: "src_00000001", url: "https://invalid.example/unknown" }
  ] })
  fake.emitDatabaseChange({ id: "theme", doc: { list: "light" } })
  fake.emitDatabaseChange({ id: "swipe", doc: { list: { twoStage: false } } })
  fake.emitHistory("undo")
  assert.ok(settings.includes("sources"))
  assert.ok(settings.includes("theme"))
  assert.ok(settings.includes("swipe"))
  assert.equal(sourceErrors.at(-1)[0].title, "No Handler")
  assert.deepEqual(history, ["undo"])
})

test("suppresses a local swipe settings echo without hiding remote changes", async () => {
  const fake = createFakePlatform([], { emitDatabaseChangesOnSet: true })
  const app = createOnceApp(fake.ports)
  const settings = []
  app.client.subscribe("settingsChanged", ({ section }) => settings.push(section))
  await app.start()

  const swipe = await app.client.getSwipeSettings()
  await app.client.setSwipeSettings({ ...swipe, twoStage: false })
  assert.deepEqual(settings.filter((section) => section === "swipe"), ["swipe"])

  fake.emitDatabaseChange({
    id: "swipe",
    doc: { list: { ...swipe, twoStage: true } }
  })
  assert.deepEqual(settings.filter((section) => section === "swipe"), [
    "swipe",
    "swipe"
  ])
})
