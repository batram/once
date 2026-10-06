const test = require("node:test")
const assert = require("node:assert/strict")
const { TabStates, restorePlan } = require("../../../packages/app/dist/tabsync/TabStates")
const { pageScriptSource } = require("../../../packages/app/dist")

const at = "2026-10-06T10:00:00.000Z"
const tab = (fields = {}) => ({ id: "t", navSeq: 1, url: "https://video.example/a", title: "", mode: "web", active: true,
  openedAt: at, navigatedAt: at, selectedAt: at, activityAt: at, ...fields })

test("state belongs to one page, counts as activity when it changes, and is kept while unreadable", async () => {
  let media = { currentTime: 30, duration: 600, paused: false, rate: 1 }
  const states = new TabStates({ runInPage: async () => media, readerPosition: async () => ({ fraction: 0.5, anchor: null }) })
  assert.equal(await states.capture(tab()), true)
  assert.equal(await states.capture(tab()), false, "the same position is no change")
  media = { ...media, currentTime: 45 }
  assert.equal(await states.capture(tab()), true)
  const [window] = states.attach([{ id: "w", focused: true, tabs: [tab()] }])
  assert.equal(window.tabs[0].state.media.data.currentTime, 45)
  assert.ok(Date.parse(window.tabs[0].activityAt) > Date.parse(at), "playing on counts as using the tab")
  media = null
  assert.equal(await states.capture(tab()), false)
  assert.equal(states.attach([{ id: "w", focused: true, tabs: [tab()] }])[0].tabs[0].state.media.data.currentTime, 45, "a page that cannot be read now keeps what was known")
  assert.equal(states.attach([{ id: "w", focused: true, tabs: [tab({ navSeq: 2 })] }])[0].tabs[0].state, undefined, "a new page drops the old state")
  await states.capture(tab({ id: "r", mode: "reader" }))
  assert.equal(states.attach([{ id: "w", focused: true, tabs: [tab({ id: "r", mode: "reader" })] }])[0].tabs[0].state["reader.scroll"].data.fraction, 0.5)
})

test("a restore plan starts YouTube by URL, seeks other media in the page and scrolls an article to its block", () => {
  const media = { media: { v: 1, capturedAt: at, data: { currentTime: 125, duration: 600, paused: true, rate: 1.25 } } }
  assert.deepEqual(restorePlan("https://www.youtube.com/watch?v=x", "web", media), { url: "https://www.youtube.com/watch?v=x&t=125s" })
  const page = restorePlan("https://video.example/a", "web", media)
  assert.equal(page.url, "https://video.example/a")
  assert.match(pageScriptSource(page.restore), /\(\.\.\.\[125,1\.25\]\)$/)
  const reader = { "reader.scroll": { v: 1, capturedAt: at, data: { fraction: 0.3, anchor: { index: 4, text: "Fourth" } } } }
  const plan = restorePlan("https://news.example/a", "reader", reader)
  assert.deepEqual(plan.readerPosition, { fraction: 0.3, anchor: { index: 4, text: "Fourth" } })
  assert.deepEqual(plan.restore.args, [0.3, 4, "Fourth"])
  assert.deepEqual(restorePlan("https://video.example/a", "web", { media: { v: 9, capturedAt: at, data: {} } }), { url: "https://video.example/a" }, "a newer version is left alone")
})
