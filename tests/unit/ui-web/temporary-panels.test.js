const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

// Temporary panels (an add-on conversation, a story's comments) come and go
// in any order. Closing one must land on a panel that still exists: returning
// to one already removed left the reader on an empty panel with only the
// matched story in it.
function setup() {
  const { document, CustomEvent, Event } = parseHTML(`<html><body>
    <div id="left_panel">
      <div id="menu"><div id="status_dock"></div></div>
      <div id="left_main">
        <div id="stories_panel" class="panel"></div>
        <div id="settings_panel" class="panel"></div>
        <div id="reading_panel" class="panel"></div>
      </div>
    </div></body></html>`)
  Object.assign(global, { document, CustomEvent, Event })
  const navigation = require("../../../packages/ui-web/dist/shell/panelNavigation")
  const { TemporaryPanel } = require("../../../packages/ui-web/dist/shell/temporaryPanel")
  navigation.open_panel("stories")
  const active = () => document.querySelector("#left_panel").getAttribute("active_panel")
  const open = name => {
    const panel = TemporaryPanel.create(name, () => panel.remove())
    panel.show()
    return panel
  }
  return { document, navigation, active, open }
}

test("closing a temporary panel returns to the last panel that still exists", () => {
  const { document, navigation, active, open } = setup()

  // Comments over an add-on conversation; the add-on goes first, unseen.
  const addon = open("addon")
  const comments = open("comments")
  assert.equal(active(), "comments")
  addon.remove()
  assert.equal(active(), "comments")
  comments.remove()
  assert.equal(active(), "stories", "the add-on panel it came from is gone")

  // The other way round: the one on top closes, the one below shows again.
  const second = open("addon")
  const third = open("comments")
  third.remove()
  assert.equal(active(), "addon")
  second.remove()
  assert.equal(active(), "stories")

  // From settings, through a visit to the stories, back to the panel: closing
  // returns to the latest panel before it, not to where it was first opened from.
  navigation.open_panel("settings")
  const panel = open("comments")
  navigation.open_panel("stories")
  navigation.open_panel("comments")
  panel.remove()
  assert.equal(active(), "stories")

  // Both entries and both panels are gone, and removing again changes nothing.
  panel.remove()
  assert.equal(active(), "stories")
  assert.equal(document.querySelectorAll(".temporary_panel, .temporary_panel_menu, .temporary_panel_bar").length, 0)
})

test("asking for a panel that is gone shows the last open one instead", () => {
  const { navigation, active, open } = setup()
  navigation.open_panel("settings")
  const comments = open("comments")
  navigation.open_panel("stories")
  comments.remove()
  // Settings' back step names the panel Settings was opened from, which may be gone by now.
  navigation.open_panel("settings")
  navigation.open_panel("comments")
  assert.equal(active(), "stories")
})
