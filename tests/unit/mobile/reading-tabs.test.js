const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const ts = require("typescript")
const { ReadingSession } = require("../../../packages/ui-web/dist/ReadingSession")
const { Story } = require("../../../packages/core/dist/story/Story")
const { readReaderPosition } = require("../../../packages/core/dist/tabsync/tabState")
const compiled = ts.transpileModule(fs.readFileSync(require("node:path").join(__dirname, "../../../apps/mobile/src/readingTabs.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const transpile = file => ts.transpileModule(fs.readFileSync(require("node:path").join(__dirname, "../../../apps/mobile/src", file), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const historyExports = {}
Function("exports", "require", transpile("readingHistory.ts"))(historyExports, () => ({}))
const moduleExports = {}
Function("exports", "require", compiled)(moduleExports, name =>
  name === "@once/core" ? { Story, readReaderPosition } : name === "./readingHistory" ? historyExports : { ReadingSession })
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


test("previews survive a restart, undo, and discard navigated or closed generations", () => {
  const storage = memory()
  const tabs = new ReadingTabs(storage)
  const tab = tabs.create()
  tab.session.navigate("https://one.test/")
  const preview = "data:image/jpeg;base64,fixture"
  tabs.setPreview(tab.id, tab.generation, "https://one.test/", preview)
  assert.equal(tab.preview, preview)
  tabs.select(tabs.create(false).id)
  assert.equal(new ReadingTabs(storage).tabs[0].preview, preview)
  tabs.close(tab.id)
  assert.equal(new ReadingTabs(storage).tabs[0].preview, undefined, "a closed tab's preview is dropped from storage")
  tabs.undo()
  assert.equal(tabs.tabs[0].preview, preview)
  assert.equal(new ReadingTabs(storage).tabs[0].preview, preview)
  tabs.select(tabs.tabs[0].id)
  tabs.close(tabs.tabs[1].id)
  const restored = tabs.tabs[0]
  restored.session.navigate("https://two.test/")
  assert.equal(restored.preview, undefined)
  assert.equal(new ReadingTabs(storage).tabs[0].preview, undefined, "a navigated tab does not restore the old page's preview")
  tabs.setPreview(restored.id, restored.generation, "https://one.test/", preview)
  assert.equal(restored.preview, undefined)
  tabs.close(restored.id)
  tabs.undo()
  tabs.setPreview(restored.id, restored.generation, "https://two.test/", preview)
  assert.equal(tabs.selected.preview, undefined)
})

test("previews that do not fit in storage keep the most recently used ones", () => {
  const values = new Map()
  const storage = { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { if (value.length > 200) throw Error("quota"); values.set(key, value) } }
  const tabs = new ReadingTabs({ getItem: storage.getItem, setItem: (key, value) => key.includes("previews") ? storage.setItem(key, value) : values.set(key, value) })
  const [a, b, c] = [tabs.create(), tabs.create(), tabs.create()]
  for (const [index, tab] of [a, b, c].entries()) {
    tab.session.navigate(`https://${index}.test/`)
    tab.times.activityAt = index
    tabs.setPreview(tab.id, tab.generation, `https://${index}.test/`, "data:image/jpeg;base64," + "x".repeat(60))
  }
  tabs.update(c.id, c.generation, { title: "Saved now" })
  assert.deepEqual(new ReadingTabs(storage).tabs.map(tab => Boolean(tab.preview)), [false, false, true])
})

test("reader scroll reports save lazily without republishing, and story refreshes publish once", () => {
  const storage = memory()
  const tabs = new ReadingTabs(storage)
  const story = new Story("rss", "https://one.test/", "Story")
  const first = tabs.create()
  first.session.open(story, "reader")
  const second = tabs.create(false)
  second.session.open(story, "browser")
  let published = 0
  tabs.subscribe(() => { published += 1 })
  published = 0
  tabs.update(first.id, first.generation, { readerScroll: 300 })
  assert.equal(published, 0)
  assert.equal(first.readerScroll, 300)
  tabs.refreshStories([story])
  assert.equal(published, 1)
  assert.equal(new ReadingTabs(storage).tabs[0].readerScroll, 300, "the next publish persists pending scroll")
})

test("same-document history keeps the page's title and scroll; a new navigation resets them", () => {
  const tabs = new ReadingTabs(memory())
  const tab = tabs.create()
  tab.session.navigate("https://one.test/")
  tab.session.navigationStarted(1, "https://one.test/")
  tab.session.navigationFinished(1, "https://one.test/")
  tabs.update(tab.id, tab.generation, { title: "App", readerScroll: 120 })
  tab.session.historyChanged(1, "https://one.test/route", true)
  assert.equal(tab.title, "App")
  assert.equal(tab.readerScroll, 120)
  tab.session.navigationStarted(2, "https://one.test/other")
  assert.equal(tab.title, "")
  assert.equal(tab.readerScroll, 0)
})

test("undo keeps a tab the user selected after the close", () => {
  const tabs = new ReadingTabs(memory())
  const a = tabs.create(), b = tabs.create()
  tabs.close(b.id)
  const c = tabs.create()
  tabs.undo()
  assert.deepEqual(tabs.tabs.map(tab => tab.id), [a.id, b.id, c.id])
  assert.equal(tabs.activeId, c.id)
  tabs.closeAll()
  const d = tabs.create()
  tabs.undo()
  assert.equal(tabs.activeId, d.id)
})

test("tab audio is playing while audible and stays marked as played afterwards", () => {
  const tabs = new ReadingTabs(memory())
  const tab = tabs.create()
  let published = 0
  tabs.subscribe(() => { published += 1 })
  published = 0
  tabs.setAudio(tab.id, tab.generation, false)
  assert.equal(tab.audio, undefined, "silence never marks a tab")
  tabs.setAudio(tab.id, tab.generation, true)
  assert.equal(tab.audio, "playing")
  tabs.setAudio(tab.id, tab.generation, true)
  tabs.setAudio(tab.id, tab.generation, false)
  assert.equal(tab.audio, "played")
  tabs.setAudio(tab.id, "stale", true)
  assert.equal(tab.audio, "played", "a replaced generation cannot mark the tab")
  assert.equal(published, 2)
})

test("tab sync times count navigations and selections, and survive a restart", () => {
  const storage = memory()
  const tabs = new ReadingTabs(storage)
  const first = tabs.create()
  first.session.navigate("https://one.test/")
  first.session.navigate("https://one.test/next")
  assert.equal(first.times.navSeq, 2)
  const second = tabs.create(false)
  const selectedBefore = second.times.selectedAt
  tabs.select(second.id)
  assert.ok(second.times.selectedAt >= selectedBefore)
  const restored = new ReadingTabs(storage)
  assert.equal(restored.tabs[0].times.navSeq, 2, "a restore keeps the navigation count instead of counting the restore")
  assert.equal(restored.tabs[0].times.openedAt, first.times.openedAt)
})

test("desktop site is kept per tab across a restart and undo, and stale generations are ignored", () => {
  const storage = memory()
  const tabs = new ReadingTabs(storage)
  const desktop = tabs.create()
  desktop.session.navigate("https://earth.test/")
  const mobile = tabs.create(false)
  mobile.session.navigate("https://news.test/")
  tabs.setDesktopSite(desktop.id, desktop.generation, true)
  tabs.setDesktopSite(mobile.id, "stale", true)
  tabs.select(mobile.id)
  assert.deepEqual(new ReadingTabs(storage).tabs.map(tab => tab.desktopSite === true), [true, false])
  assert.equal(JSON.parse(storage.getItem("once:mobile-reading-tabs:v1")).tabs[1].desktopSite, undefined, "off is not written")
  tabs.close(desktop.id)
  tabs.undo()
  assert.equal(tabs.tabs[0].desktopSite, true)
  tabs.setDesktopSite(tabs.tabs[0].id, tabs.tabs[0].generation, false)
  tabs.select(tabs.tabs[0].id)
  assert.deepEqual(new ReadingTabs(storage).tabs.map(tab => tab.desktopSite === true), [false, false])
})
