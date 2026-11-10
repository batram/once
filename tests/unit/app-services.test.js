const test = require("node:test")
const assert = require("node:assert/strict")
const { Story } = require("../../packages/core/dist")
const { AppSettings } = require("../../packages/app/dist/AppSettings")
const { StoryWorkingSet } = require("../../packages/app/dist/StoryWorkingSet")
const { StoryWriteQueue } = require("../../packages/app/dist/StoryWriteQueue")
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
      evictRemovedSources: () => {},
      loadedStoryIds: () => []
    }
  )

  // A filter list change publishes at once, so an echo that got through would show.
  await settings.saveFilterList(["example.com"])
  settings.handleObservedChange(observed)
  assert.deepEqual(changed, ["filters"])

  settings.handleObservedChange({ id: "filter_list", doc: { list: ["other.example"] } })
  assert.deepEqual(changed, ["filters", "filters"], "another client's write is still announced")
  settings.handleObservedChange(observed)
  assert.deepEqual(changed, ["filters", "filters", "filters"], "the echo is suppressed once only")
})

test("a default list handed out is the caller's own, so changing it leaves the default alone", async () => {
  const { defaultFilterList, defaultRedirectList } = require("../../packages/core/dist")
  const filters = [...defaultFilterList], redirects = structuredClone(defaultRedirectList)
  const lists = new Map()
  let failing = false
  const settings = new AppSettings(
    {
      get: async (id, fallback) => { if (failing) throw new Error("unreadable"); return lists.get(id) ?? fallback },
      set: async (id, value) => { lists.set(id, structuredClone(value)) }
    },
    { getSyncUrl: async () => "", setSyncUrl: async () => {}, getCacheTime: async () => 120, setCacheTime: async () => {} },
    undefined,
    { setTheme: () => {} },
    {
      publishChanged: () => {}, reportDiagnostic: () => {}, reloadStories: () => {}, refilterStories: () => {},
      refreshRedirects: () => {}, updateSourceMenu: () => {}, evictRemovedSources: () => {}, loadedStoryIds: () => []
    }
  )

  await settings.addFilter("added.example")
  assert.deepEqual(lists.get("filter_list"), [...filters, "added.example"])
  assert.deepEqual(defaultFilterList, filters, "adding the first filter does not grow the shared default")

  lists.clear()
  ;(await settings.getRedirectList())[0].replace_url = "https://changed.example/"
  ;(await settings.getRedirectList()).push({ match_url: "a", replace_url: "b" })
  assert.deepEqual(defaultRedirectList, redirects)
  assert.deepEqual(await settings.getRedirectList(), redirects)

  // The default a failed read falls back to is a copy as well.
  failing = true
  ;(await settings.getFilterList()).push("after-failure.example")
  assert.deepEqual(defaultFilterList, filters)
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
      evictRemovedSources: () => {},
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
