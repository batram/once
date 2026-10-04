const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const ts = require("typescript")
const { ReadingSession } = require("../../../packages/ui-web/dist/ReadingSession")
const { Story } = require("../../../packages/core/dist/story/Story")
const compiled = ts.transpileModule(fs.readFileSync(require("node:path").join(__dirname, "../../../apps/mobile/src/readingTabs.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const moduleExports = {}
Function("exports", "require", compiled)(moduleExports, name => name === "@once/core" ? { Story } : { ReadingSession })
const { ReadingTabs } = moduleExports
const memory = () => {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

test("tabs isolate sessions, navigation state and failures; a background create preserves selection", () => {
  const tabs = new ReadingTabs(memory())
  const first = tabs.create()
  first.session.navigate("https://one.test/")
  first.session.historyChanged(4, "https://one.test/", true)
  const second = tabs.create(false)
  second.session.navigate("https://two.test/")
  second.session.navigationFailed(1, "https://two.test/", "failed")
  assert.equal(tabs.activeId, first.id)
  assert.equal(first.session.snapshot().canGoBack, true)
  assert.equal(first.session.snapshot().error, null)
  assert.equal(second.session.snapshot().error, "failed")
})

test("close selects the preceding tab, then the next, while inactive close preserves selection", () => {
  const tabs = new ReadingTabs(memory())
  const a = tabs.create(), b = tabs.create(), c = tabs.create()
  tabs.close(c.id)
  assert.equal(tabs.activeId, b.id)
  tabs.select(a.id)
  tabs.close(b.id)
  assert.equal(tabs.activeId, a.id)
  const d = tabs.create(false)
  tabs.close(a.id)
  assert.equal(tabs.activeId, d.id)
  tabs.close(d.id)
  assert.equal(tabs.activeId, null)
})

test("undo retains surviving runtimes, restores order/selection, and rejects stale runtime metadata", () => {
  const tabs = new ReadingTabs(memory())
  const a = tabs.create(), b = tabs.create(), c = tabs.create()
  tabs.select(b.id)
  tabs.close(b.id)
  tabs.undo()
  assert.deepEqual(tabs.tabs.map(tab => tab.id), [a.id, b.id, c.id])
  assert.equal(tabs.selected.id, b.id)
  assert.equal(tabs.tabs[0], a)
  assert.notEqual(tabs.selected.generation, b.generation)
  tabs.update(b.id, b.generation, { title: "late title" })
  assert.equal(tabs.selected.title, "")
  tabs.closeAll()
  assert.equal(tabs.tabs.length, 0)
  tabs.undo()
  assert.deepEqual(tabs.tabs.map(tab => tab.id), [a.id, b.id, c.id])
  assert.equal(tabs.selected.id, b.id)
  assert.equal(tabs.canUndo, false)
})

test("restart restores metadata lazily without errors/history/loading or undo", () => {
  const storage = memory()
  const tabs = new ReadingTabs(storage)
  const tab = tabs.create()
  const story = new Story("rss", "https://one.test/", "Saved story")
  tab.session.open(story, "reader")
  tabs.update(tab.id, tab.generation, { readerScroll: 423, title: "Saved title" })
  tab.session.readerFailed(story.href, "old error")
  const next = new ReadingTabs(storage)
  assert.equal(next.selected.id, tab.id)
  assert.equal(next.selected.restored, true)
  assert.equal(next.selected.readerScroll, 423)
  assert.equal(next.selected.title, "Saved title")
  assert.equal(next.selected.session.snapshot().story.matches_url(story.href), true)
  assert.equal(next.selected.session.snapshot().error, null)
  assert.equal(next.selected.session.snapshot().loadState, "idle")
  assert.equal(next.canUndo, false)
  assert.equal(new ReadingTabs(storage).tabs.length, 1, "restoration must not overwrite the saved snapshot with an incomplete one")
})

test("feed removal retains story context and a later feed refresh updates it", () => {
  const tabs = new ReadingTabs(memory()), tab = tabs.create()
  const story = new Story("rss", "https://one.test/", "Old title")
  tab.session.open(story, "browser")
  tabs.refreshStories([])
  assert.equal(tab.session.snapshot().story.title, "Old title")
  tabs.refreshStories([new Story("rss", story.href, "New title")])
  assert.equal(tab.session.snapshot().story.title, "New title")
})

test("malformed snapshots and unavailable storage leave tab operations usable", () => {
  for (const storage of [
    { getItem() { throw Error("denied") }, setItem() { throw Error("denied") } },
    { getItem() { return "{" }, setItem() {} },
    { getItem() { return JSON.stringify({ version: 99, tabs: [] }) }, setItem() {} }
  ]) {
    const tabs = new ReadingTabs(storage)
    assert.equal(tabs.tabs.length, 0)
    assert.ok(tabs.create())
    tabs.closeAll()
    tabs.undo()
    assert.equal(tabs.tabs.length, 1)
  }
})


test("previews stay in memory and discard navigated or closed generations", () => {
  const storage = memory()
  const tabs = new ReadingTabs(storage)
  const tab = tabs.create()
  tab.session.navigate("https://one.test/")
  const preview = "data:image/jpeg;base64,fixture"
  tabs.setPreview(tab.id, tab.generation, "https://one.test/", preview)
  assert.equal(tab.preview, preview)
  assert.equal(new ReadingTabs(storage).selected.preview, undefined)
  tab.session.navigate("https://two.test/")
  assert.equal(tab.preview, undefined)
  tabs.setPreview(tab.id, tab.generation, "https://one.test/", preview)
  assert.equal(tab.preview, undefined)
  tabs.close(tab.id)
  tabs.undo()
  tabs.setPreview(tab.id, tab.generation, "https://two.test/", preview)
  assert.equal(tabs.selected.preview, undefined)
})
