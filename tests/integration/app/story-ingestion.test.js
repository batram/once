const test = require("node:test")
const assert = require("node:assert/strict")
const { AppRuntime } = require("../../../packages/app/dist/AppRuntime")
const { StoryIngestionQueue } = require("../../../packages/app/dist/StoryIngestionQueue")
const { Story } = require("../../../packages/core/dist")
const { createFakePlatform } = require("../../helpers/fake-platform")

const tick = () => new Promise(resolve => setImmediate(resolve))
const story = (href, tags = []) => {
  const result = new Story("rss", href, "A story", `${href}/comments`, 1784678400000)
  result.tags = tags.map(text => ({ text, class: "source", href: `search:${text}` }))
  return result
}

test("ingestion gate transfers slots in FIFO order and recovers from sync and async failures", async () => {
  const queue = new StoryIngestionQueue(1)
  const order = []
  let release
  const first = queue.run(async () => {
    order.push(1)
    await new Promise(resolve => { release = resolve })
  })
  const second = queue.run(() => { order.push(2); throw new Error("sync failure") })
  const secondFailure = assert.rejects(second, /sync failure/)
  const third = queue.run(async () => { order.push(3); throw new Error("async failure") })
  const thirdFailure = assert.rejects(third, /async failure/)
  const fourth = queue.run(async () => { order.push(4); return "done" })
  assert.deepEqual(order, [1])
  release()
  await Promise.all([first, secondFailure, thirdFailure])
  assert.equal(await fourth, "done")
  assert.deepEqual(order, [1, 2, 3, 4])
  assert.equal(await queue.run(async () => "reused"), "reused")
})

test("six source batches share 64 ingestion slots and publish in input order", async () => {
  const fake = createFakePlatform()
  const app = new AppRuntime(fake.ports)
  const save = fake.ports.storyStore.saveStory
  let active = 0, peak = 0, started = 0, release
  const blocked = new Promise(resolve => { release = resolve })
  fake.ports.storyStore.saveStory = async incoming => {
    active++
    started++
    peak = Math.max(peak, active)
    try { await blocked; return await save(incoming) }
    finally { active-- }
  }
  let lookups = 0
  const lookup = fake.ports.storyStore.getStoriesByUrls
  fake.ports.storyStore.getStoriesByUrls = async urls => { lookups++; return lookup(urls) }
  const published = []
  app.client.subscribe("storiesChanged", event => published.push(event.stories))
  const batches = Array.from({ length: 6 }, (_, source) => Array.from({ length: 100 }, (_, index) =>
    story(`https://example.com/${source}/${index}`)))
  const runs = batches.map((batch, source) => app.processStoryInput(batch, `source-${source}`))
  await tick()
  assert.equal(started, 64)
  assert.equal(active, 64)
  assert.equal(lookups, 6)
  release()
  await Promise.all(runs)
  assert.equal(started, 600)
  assert.equal(peak, 64)
  assert.equal(active, 0)
  assert.equal(published.length, 6)
  for (const batch of batches) {
    const output = published.find(result => result[0].href === batch[0].href)
    assert.deepEqual(output.map(item => item.href), batch.map(item => item.href))
  }
})

test("a saturated ingestion gate preserves same-URL write order without blocking unrelated edits", async () => {
  const fake = createFakePlatform()
  const app = new AppRuntime(fake.ports)
  const save = fake.ports.storyStore.saveStory
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const href = "https://example.com/queued"
  const order = []
  fake.ports.storyStore.saveStory = async incoming => {
    if (incoming.href === href) order.push("ingested")
    await blocked
    return save(incoming)
  }
  const batch = Array.from({ length: 64 }, (_, index) => story(`https://example.com/blocked/${index}`))
  batch.push(story(href))
  const ingestion = app.addStories(batch)
  await tick()
  const sameUrlEdit = app.queueStoryWrite(href, async () => order.push("edited"))
  await app.queueStoryWrite("https://example.com/independent", async () => order.push("independent"))
  assert.deepEqual(order, ["independent"])
  release()
  await Promise.all([ingestion, sameUrlEdit])
  assert.deepEqual(order, ["independent", "ingested", "edited"])
})

test("failed ingestion releases slots and all queued writes settle", async t => {
  t.mock.method(console, "error", () => {})
  const fake = createFakePlatform()
  const app = new AppRuntime(fake.ports)
  const save = fake.ports.storyStore.saveStory
  const diagnostics = []
  app.client.subscribe("diagnosticError", error => diagnostics.push(error))
  let attempted = 0
  fake.ports.storyStore.saveStory = async incoming => {
    attempted++
    await tick()
    if (incoming.href.endsWith("/0")) throw new Error("injected save failure")
    return save(incoming)
  }
  await assert.rejects(app.addStories(Array.from({ length: 130 }, (_, index) =>
    story(`https://example.com/failure/${index}`))), /injected save failure/)
  await app.client.settledStoryWrites()
  assert.equal(attempted, 130)
  assert.equal(diagnostics.length, 1)
  assert.equal(await fake.ports.storyStore.getStory("https://example.com/failure/0"), null)
  fake.ports.storyStore.saveStory = save
  await app.addStories([story("https://example.com/failure/0")])
  assert.ok(await fake.ports.storyStore.getStory("https://example.com/failure/0"))
  assert.equal((await app.addStories([story("https://example.com/after-failure")])).length, 1)
})

test("tag subsets and reordering cause no save or change event; additions are deduplicated", async () => {
  const href = "https://example.com/tags"
  const stored = story(href, ["A", "B"])
  const fake = createFakePlatform([stored])
  const app = new AppRuntime(fake.ports)
  let saves = 0
  const save = fake.ports.storyStore.saveStory
  fake.ports.storyStore.saveStory = async incoming => { saves++; return save(incoming) }
  const changes = []
  app.client.subscribe("storyChanged", event => { if (event.path[1] === "tags") changes.push(event) })
  await app.addStories([story(href, ["B", "A"])])
  await app.addStories([story(href, ["A"])])
  assert.equal(saves, 0)
  assert.equal(changes.length, 0)
  await app.addStories([story(href, ["B", "C", "C"])])
  assert.equal(saves, 1)
  assert.equal(changes.length, 1)
  assert.deepEqual(stored.tags.map(tag => tag.text), ["A", "B", "C"])
})

test("duplicate source URLs remain serialized and preserve both sources' metadata", async () => {
  const fake = createFakePlatform()
  const app = new AppRuntime(fake.ports)
  const href = "https://example.com/shared"
  const result = await app.addStories([story(href, ["first"]), story(href, ["second"])])
  assert.equal(result[0], result[1])
  assert.deepEqual(result[0].tags.map(tag => tag.text), ["first", "second"])
  assert.deepEqual((await fake.ports.storyStore.getStory(href)).tags, result[0].tags)
})

test("failed tag additions are rolled back so a source retry persists them", async t => {
  t.mock.method(console, "error", () => {})
  const href = "https://example.com/tag-retry"
  const stored = story(href, ["A"])
  const fake = createFakePlatform([stored])
  const app = new AppRuntime(fake.ports)
  const save = fake.ports.storyStore.saveStory
  fake.ports.storyStore.saveStory = async () => { throw new Error("injected failure") }
  await assert.rejects(app.addStories([story(href, ["A", "B"])]), /injected failure/)
  assert.deepEqual(stored.tags.map(tag => tag.text), ["A"])
  fake.ports.storyStore.saveStory = save
  await app.addStories([story(href, ["A", "B"])])
  assert.deepEqual((await fake.ports.storyStore.getStory(href)).tags.map(tag => tag.text), ["A", "B"])
})

test("a queued user edit survives rollback of a failed new-story insertion", async t => {
  t.mock.method(console, "error", () => {})
  const fake = createFakePlatform()
  const app = new AppRuntime(fake.ports)
  const save = fake.ports.storyStore.saveStory
  let rejectInsertion
  const blocked = new Promise((_resolve, reject) => { rejectInsertion = reject })
  let attempts = 0
  fake.ports.storyStore.saveStory = async incoming => {
    if (++attempts === 1) return blocked
    return save(incoming)
  }
  const href = "https://example.com/failed-insertion-with-edit"
  const insertion = app.addStories([story(href)])
  const failure = assert.rejects(insertion, /injected failure/)
  await tick()
  const edit = app.client.persistStoryChange(href, "read_state", "read")
  await tick()
  rejectInsertion(new Error("injected failure"))
  await failure
  await edit
  assert.equal((await app.client.findStoryByUrl(href)).read_state, "read")
  assert.equal((await fake.ports.storyStore.getStory(href)).read_state, "read")
})

test("empty batches skip the bulk lookup", async () => {
  const fake = createFakePlatform()
  fake.ports.storyStore.getStoriesByUrls = async () => { throw new Error("unexpected lookup") }
  assert.deepEqual(await new AppRuntime(fake.ports).addStories([]), [])
})
