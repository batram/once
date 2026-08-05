const test = require("node:test")
const assert = require("node:assert/strict")
const { Story } = require("../../packages/core/dist")
const { AppSettings } = require("../../packages/app/dist/AppSettings")
const { StoryWorkingSet } = require("../../packages/app/dist/StoryWorkingSet")
const { StoryWriteQueue } = require("../../packages/app/dist/StoryWriteQueue")
const { SourceLoader } = require("../../packages/app/dist/SourceLoader")
const { waitForStartupStorage } = require("../../packages/app/dist/startupStorage")
const {
  acceptRemoteStorySyncState,
  mergeStorySyncState
} = require("../../packages/app/dist/storySyncPolicy")

test("settings suppress the matching local database echo", async () => {
  const changed = []
  let observed
  const lists = new Map()
  const settings = new AppSettings(
    {
      get: async (id, fallback) => lists.get(id) ?? fallback,
      set: async (id, value) => {
        lists.set(id, value)
        observed = { id, doc: { list: value } }
      }
    },
    {
      getSyncUrl: async () => "",
      setSyncUrl: async () => {},
      getCacheTime: async () => 120,
      setCacheTime: async () => {}
    },
    undefined,
    { setTheme: () => {} },
    {
      publishChanged: (section) => changed.push(section),
      reportDiagnostic: () => {},
      reloadStories: () => changed.push("reload"),
      refilterStories: () => {},
      refreshRedirects: () => {},
      updateSourceMenu: () => {},
      loadedStoryIds: () => []
    }
  )

  await settings.saveStorySources({ version: 2, groups: [], sources: [
    { id: "src_00000001", url: "https://example.com/feed" }
  ] }, false)
  settings.handleObservedChange(observed)

  assert.deepEqual(changed, ["sources"])
})

test("settings reject and do not persist a sync URL without an HTTP scheme", async () => {
  const saved = []
  const diagnostics = []
  const settings = new AppSettings(
    { get: async (_id, fallback) => fallback, set: async () => {} },
    {
      getSyncUrl: async () => "",
      setSyncUrl: async (value) => saved.push(value),
      getCacheTime: async () => 120,
      setCacheTime: async () => {}
    },
    undefined,
    { setTheme: () => {} },
    {
      publishChanged: () => {},
      reportDiagnostic: (error) => diagnostics.push(error),
      reloadStories: () => {},
      refilterStories: () => {},
      refreshRedirects: () => {},
      updateSourceMenu: () => {},
      loadedStoryIds: () => []
    }
  )

  await assert.rejects(
    settings.setSyncUrl("user:secret@example.test/once"),
    /must start with http:\/\//
  )
  assert.deepEqual(saved, [])
  assert.equal(diagnostics.at(-1).message, "The CouchDB URL is invalid")
  assert.doesNotMatch(diagnostics.at(-1).details, /secret|example\.test/)
})

test("story write queue serializes each href but keeps hrefs independent", async () => {
  const queue = new StoryWriteQueue(() => {})
  const order = []
  let release
  const blocked = new Promise((resolve) => { release = resolve })
  const first = queue.enqueue("a", async () => {
    order.push("a1")
    await blocked
    order.push("a1-done")
  })
  const second = queue.enqueue("a", async () => order.push("a2"))
  const independent = queue.enqueue("b", async () => order.push("b1"))

  await independent
  assert.deepEqual(order, ["a1", "b1"])
  release()
  await Promise.all([first, second])
  assert.deepEqual(order, ["a1", "b1", "a1-done", "a2"])
})

test("working set owns story and comment-url lookup plus removal", () => {
  const removed = []
  const story = new Story(
    "rss",
    "https://example.com/story",
    "Story",
    "https://example.com/comments"
  )
  const workingSet = new StoryWorkingSet(
    () => {},
    () => {},
    (href) => removed.push(href)
  )

  workingSet.set(story.href, story)
  assert.equal(workingSet.lookup(story.comment_url), story)
  workingSet.remove(story.href)
  assert.equal(workingSet.lookup(story.comment_url), null)
  assert.deepEqual(removed, [story.href])
})

test("story sync policy merges timestamps and supports authoritative reset", () => {
  const local = new Story("rss", "https://example.com/story", "Story")
  local.read_state = "read"
  local.stared = true
  local.sync_updated_at = { read_state: 100, stared: 300 }
  const remote = Story.from_obj({
    ...local.to_obj(),
    read_state: "skipped",
    stared: false,
    sync_updated_at: { read_state: 200, stared: 200 }
  })

  const merged = mergeStorySyncState(local, remote)
  assert.equal(merged.read_state, "skipped")
  assert.equal(merged.stared, true)
  assert.deepEqual(merged.sync_updated_at, { read_state: 200, stared: 300 })

  const accepted = acceptRemoteStorySyncState(local, remote)
  assert.equal(accepted.stared, false)
  assert.deepEqual(accepted.sync_updated_at, remote.sync_updated_at)
})

test("source loader rejects expired cache before fetching", async () => {
  const errors = []
  let requests = 0
  const loader = new SourceLoader(
    async () => {
      requests += 1
      return new Response("missing", { status: 404, statusText: "Not Found" })
    },
    {
      get: async () => [Date.now() - 10 * 60 * 1000, "{}"],
      set: async () => {}
    },
    async () => 5,
    (error) => errors.push(error)
  )

  await assert.rejects(
    loader.load({ id: "src_00000001", url: "https://old.reddit.com/r/netsec/.json" }),
    /HTTP 404/
  )
  assert.equal(requests, 1)
  assert.deepEqual(errors, [])
})

test("startup storage timeout reports and continues while work stays pending", async () => {
  const events = []
  await waitForStartupStorage(
    "stared stories",
    () => new Promise(() => {}),
    {
      timedOut: (label) => events.push(["timeout", label]),
      failed: (label, error) => events.push(["failed", label, error])
    },
    5
  )

  assert.deepEqual(events, [["timeout", "stared stories"]])
})
