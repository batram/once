const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { StoryHistory } = require("../../../packages/ui-web/dist/story/StoryHistory")
const { SettingsNavigation, openSettingsPage, registerSettingsOverview, invalidateSettingsPages, completeSettingsPage } = require("../../../packages/ui-web/dist/settings/SettingsNavigation")
const { open_panel } = require("../../../packages/ui-web/dist/shell/panelNavigation")

function withDom(run) {
  const { window } = parseHTML('<html><body><main id="left_panel" active_panel="settings"><div id="settings_panel"><span class="settings_title"></span><button id="settings_section_back"></button><section class="settings_section" data-settings-section="sources"></section><section class="settings_section" data-settings-section="filters"></section></div></main></body></html>')
  const names = ["window", "document", "CustomEvent", "HTMLElement", "Element", "requestAnimationFrame"]
  const previous = names.map(name => globalThis[name])
  for (const name of names) globalThis[name] = name === "requestAnimationFrame" ? () => 0 : window[name]
  try { run(window) } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) Reflect.deleteProperty(globalThis, name)
      else globalThis[name] = previous[index]
    })
  }
}

test("mouse buttons navigate settings without changing story history; stories retain undo and redo", () => {
  withDom(window => {
    let command
    const history = new StoryHistory({ subscribe: (_name, handler) => { command = handler } })
    const entry = { story: { href: "https://example.test" }, old_state: "unread", new_state: "read" }
    history.undo_history.push(entry)
    history.redo_history.push(entry)
    const directions = []
    document.addEventListener("once-settings-navigate", event => directions.push(event.detail.direction))
    const mouse = button => {
      const event = new window.Event("mouseup", { cancelable: true })
      event.button = button
      window.dispatchEvent(event)
      return event
    }
    assert.equal(mouse(3).defaultPrevented, true)
    assert.equal(mouse(4).defaultPrevented, true)
    command({ action: "undo" })
    command({ action: "redo" })
    history.undo()
    history.redo()
    assert.deepEqual(directions, ["back", "forward"])
    assert.deepEqual(history.undo_history, [entry])
    assert.deepEqual(history.redo_history, [entry])
    document.querySelector("#left_panel").setAttribute("active_panel", "stories")
    const calls = []
    history.undo = () => calls.push("undo")
    history.redo = () => calls.push("redo")
    mouse(3)
    mouse(4)
    mouse(0)
    assert.deepEqual(calls, ["undo", "redo"])
  })
})

test("undoable changes list the latest change per story and undo only the picked one", () => {
  withDom(() => {
    document.querySelector("#left_panel").setAttribute("active_panel", "stories")
    const persisted = []
    const { setOnceClient } = require("../../../packages/ui-web/dist/client")
    setOnceClient({
      subscribe: () => () => {},
      persistStoryChange: (href, _key, state) => persisted.push([href, state])
    })
    const history = new StoryHistory({ subscribe: () => {} })
    const a = { href: "https://a.test" }
    const b = { href: "https://b.test" }
    history.story_change(a, "skipped", "unread")
    history.story_change(b, "read", "unread")
    history.story_change(a, "read", "skipped")

    const listed = history.undoableChanges()
    assert.deepEqual(listed.map(change => [change.story.href, change.new_state]), [
      ["https://a.test", "read"],
      ["https://b.test", "read"]
    ])

    history.undoChange(listed[1])
    assert.deepEqual(persisted, [["https://b.test", "unread"]])
    assert.deepEqual(history.undo_history.map(change => change.story.href), [
      "https://a.test",
      "https://a.test"
    ])

    history.undo()
    assert.deepEqual(persisted.at(-1), ["https://a.test", "skipped"])
    assert.equal(history.undo_history.length, 1)
    assert.equal(history.redo_history.length, 2)
  })
})

test("settings section history supports back, forward, boundaries and branching", () => {
  withDom(() => {
    let section = null
    const show = next => { section = next }
    const navigation = new SettingsNavigation({
      section: () => section,
      show,
      back: document.querySelector("#settings_section_back"),
      label: next => next ?? "Settings"
    })
    navigation.open("sources")
    navigation.open("filters")
    navigation.navigate("back")
    assert.equal(section, "sources")
    navigation.navigate("back")
    assert.equal(section, null)
    navigation.navigate("back")
    assert.equal(document.querySelector("#left_panel").getAttribute("active_panel"), "stories")
    const forward = new CustomEvent("once-settings-navigate", { cancelable: true, detail: { direction: "forward" } })
    document.dispatchEvent(forward)
    assert.equal(forward.defaultPrevented, true)
    assert.equal(document.querySelector("#left_panel").getAttribute("active_panel"), "settings")
    navigation.navigate("forward")
    assert.equal(section, "sources")
    navigation.navigate("forward")
    assert.equal(section, "filters")
    navigation.navigate("back")
    navigation.open(null)
    navigation.navigate("forward")
    assert.equal(section, null)
    navigation.navigate("back")
    navigation.navigate("forward")
    assert.equal(section, null)
    open_panel("stories")
    navigation.open(null)
    open_panel("settings")
    navigation.navigate("back")
    assert.equal(document.querySelector("#left_panel").getAttribute("active_panel"), "stories")
  })
})

test("one history replays nested pages across sections through header and native steps", () => {
  withDom(window => {
    let section = null
    let visible = "index"
    const back = document.querySelector("#settings_section_back")
    const navigation = new SettingsNavigation({
      section: () => section,
      show: next => { section = next; visible = next ?? "index" },
      label: next => next ?? "Settings", back
    })
    const sources = document.querySelector('[data-settings-section="sources"]')
    const filters = document.querySelector('[data-settings-section="filters"]')
    registerSettingsOverview(sources, () => { visible = "sources" })
    registerSettingsOverview(filters, () => { visible = "filters" })
    const visit = (root, key) => openSettingsPage(root, { key, title: () => key, show: () => { visible = key } })
    navigation.open("sources")
    visit(sources, "source")
    visit(sources, "source options")
    navigation.open("filters")
    visit(filters, "filter")
    for (const expected of ["filters", "source options", "source", "sources", "index"]) {
      back.click()
      assert.equal(visible, expected)
    }
    for (const expected of ["sources", "source", "source options", "filters", "filter"]) {
      const event = new window.CustomEvent("once-settings-navigate", { cancelable: true, detail: { direction: "forward" } })
      document.dispatchEvent(event)
      assert.equal(event.defaultPrevented, true)
      assert.equal(visible, expected)
    }
    navigation.navigate("back")
    visit(filters, "another filter")
    navigation.navigate("forward")
    assert.equal(visible, "another filter", "a new page drops the old forward branch")
  })
})

test("deleted pages and completed drafts cannot replay, while history traversal retains drafts", () => {
  withDom(() => {
    let section = "sources", visible = "sources", exists = true, draft = "unsaved"
    const root = document.querySelector('[data-settings-section="sources"]')
    const navigation = new SettingsNavigation({
      section: () => section, show: next => { section = next; visible = next }, label: next => next ?? "Settings",
      back: document.querySelector("#settings_section_back")
    })
    registerSettingsOverview(root, () => { visible = "sources" })
    openSettingsPage(root, { key: "draft", title: () => "Draft", valid: () => exists, show: () => { visible = draft } })
    navigation.navigate("back")
    navigation.navigate("forward")
    assert.equal(visible, "unsaved")
    navigation.navigate("back")
    exists = false
    invalidateSettingsPages()
    navigation.navigate("forward")
    assert.equal(visible, "sources")
    openSettingsPage(root, { key: "new draft", title: () => "Draft", show: () => { visible = draft } })
    completeSettingsPage(root)
    visible = "sources"
    draft = "discarded"
    navigation.navigate("forward")
    assert.equal(visible, "sources")
  })
})
