const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { StoryHistory } = require("../../../packages/ui-web/dist/story/StoryHistory")
const { SettingsNavigation } = require("../../../packages/ui-web/dist/settings/SettingsNavigation")
const { open_panel } = require("../../../packages/ui-web/dist/shell/panelNavigation")

function withDom(run) {
  const { window } = parseHTML('<html><body><main id="left_panel" active_panel="settings"><div id="settings_panel"><span class="settings_title"></span><button id="settings_section_back"></button><section class="settings_section" data-settings-section="sources"></section><section class="settings_section" data-settings-section="filters"></section></div></main></body></html>')
  const names = ["window", "document", "CustomEvent", "HTMLElement", "requestAnimationFrame"]
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

test("settings section history supports back, forward, boundaries and branching", () => {
  withDom(() => {
    let section = null
    const show = next => { navigation.record(next); section = next }
    const navigation = new SettingsNavigation({
      section: () => section,
      show,
      back: document.querySelector("#settings_section_back"),
      backEditor: () => false,
      showIndex: () => show(null),
      exitSettings: () => {},
      forwardEditor: () => false,
      clearForwardEditors: () => {}
    })
    show("sources")
    show("filters")
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
    show(null)
    navigation.navigate("forward")
    assert.equal(section, null)
    navigation.navigate("back")
    document.querySelector("#settings_panel").classList.add("settings_form_open")
    navigation.navigate("forward")
    assert.equal(section, "sources")
    document.querySelector("#settings_panel").classList.remove("settings_form_open")
    open_panel("stories")
    show(null)
    open_panel("settings")
    navigation.navigate("back")
    assert.equal(document.querySelector("#left_panel").getAttribute("active_panel"), "stories")
  })
})
