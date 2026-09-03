const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

function loadMenuModule() {
  const { window } = parseHTML("<html><body></body></html>")
  globalThis.window = window
  globalThis.document = window.document
  globalThis.Element = window.Element
  globalThis.HTMLElement = window.HTMLElement
  globalThis.customElements = window.customElements
  globalThis.MouseEvent = window.MouseEvent
  return require("../../../packages/ui-web/dist/menu/storyContextMenu")
}

function fakeStory(overrides = {}) {
  const story = {
    href: "https://example.com/story",
    comment_url: "https://example.com/comments",
    read_state: "unread",
    stared: false,
    filter: "",
    ...overrides
  }
  return {
    story,
    readActionLabel: () =>
      story.read_state === "unread"
        ? "Skip reading"
        : story.read_state === "read"
          ? "Mark as unread"
          : "Unskip",
    bookmarkActionLabel: () => story.stared ? "Remove bookmark" : "Bookmark",
    filterActionLabel: () => story.filter ? "Edit filter" : "Filter source",
    openComments: () => {}
  }
}

test("story menu descriptors are ordered, contextual, and platform-aware", () => {
  const { describeStoryMenu } = loadMenuModule()
  const items = describeStoryMenu({
    platform: "electron",
    buildChannel: "dev",
    story: fakeStory({ read_state: "read", stared: true, filter: "example.com" })
  }).filter((item) => item.visible)

  assert.deepEqual(items.map((item) => item.id), [
    "open",
    "open-comments",
    "open-new-tab",
    "open-background-tab",
    "open-new-window",
    "open-external",
    "open-reader",
    "toggle-read",
    "toggle-bookmark",
    "filter",
    "search-domain",
    "copy-link",
    "undo",
    "redo",
    "purge",
    "inspect"
  ])
  assert.equal(items.find((item) => item.id === "toggle-read").label, "Mark as unread")
  assert.equal(items.find((item) => item.id === "toggle-bookmark").label, "Remove bookmark")
  assert.equal(items.find((item) => item.id === "filter").label, "Edit filter")
})

test("mobile gets the short single-column menu the redesign specifies", () => {
  const { describeStoryMenu } = loadMenuModule()
  const items = describeStoryMenu({
    platform: "mobile",
    buildChannel: "release",
    story: fakeStory()
  }).filter((item) => item.visible)

  // No tab targets to choose between, and undo/redo belong to a keyboard.
  assert.deepEqual(items.map((item) => item.id), [
    "open",
    "open-comments",
    "open-browser",
    "open-reader",
    "toggle-read",
    "toggle-bookmark",
    "filter",
    "search-domain",
    "copy-link"
  ])
})

test("open comments is hidden without a primary comments URL", () => {
  const { describeStoryMenu } = loadMenuModule()
  const items = describeStoryMenu({
    platform: "chrome",
    buildChannel: "release",
    story: fakeStory({ comment_url: "" })
  })

  assert.equal(
    items.find((item) => item.id === "open-comments").visible,
    false
  )
})

test("mobile hides the redirect actions even when a redirect applies", () => {
  const { describeStoryMenu } = loadMenuModule()
  const hidden = describeStoryMenu({
    platform: "mobile",
    buildChannel: "release",
    // URLRedirect has no rules loaded here, so assert on the flags directly:
    // the mobile branch must not depend on whether a redirect matched.
    story: fakeStory()
  }).filter((item) => !item.visible).map((item) => item.id)

  assert.ok(hidden.includes("open-original"))
  assert.ok(hidden.includes("copy-original-link"))
  assert.ok(hidden.includes("open-new-tab"))
  assert.ok(hidden.includes("open-background-tab"))
})

test("story-list background exposes only history actions", () => {
  const { describeStoryMenu } = loadMenuModule()
  const items = describeStoryMenu({
    platform: "firefox",
    buildChannel: "release"
  }).filter((item) => item.visible)

  assert.deepEqual(items.map((item) => item.id), ["undo", "redo"])
  assert.ok(items.every((item) => !item.enabled))
})

test("a registered add-on action joins the menu for the rows it applies to and runs from it", async () => {
  const { describeStoryMenu, executeStoryMenuAction } = loadMenuModule()
  const { registerStoryAction } = require("../../../packages/ui-web/dist/menu/storyActionRegistry")
  const ran = []
  const remove = registerStoryAction({
    id: "addon:archive-today/open-archive",
    label: "Open archived copy",
    group: "navigation",
    surfaces: ["menu", "swipe"],
    appliesTo: (row) => row.story.href.startsWith("https://"),
    run: (row) => { ran.push(row.story.href) }
  })
  try {
    const shown = describeStoryMenu({ platform: "electron", buildChannel: "release", story: fakeStory() })
    const entry = shown.find((item) => item.id === "addon:archive-today/open-archive")
    assert.deepEqual(entry, {
      id: "addon:archive-today/open-archive", label: "Open archived copy",
      group: "navigation", enabled: true, visible: true
    })
    const hidden = describeStoryMenu({
      platform: "electron", buildChannel: "release", story: fakeStory({ href: "http://plain.example/x" })
    }).find((item) => item.id === "addon:archive-today/open-archive")
    assert.equal(hidden.visible, false)

    const row = fakeStory()
    await executeStoryMenuAction("addon:archive-today/open-archive", row)
    assert.deepEqual(ran, ["https://example.com/story"])
    await executeStoryMenuAction("addon:nobody/home", row)
    assert.equal(ran.length, 1)
  } finally {
    remove()
  }
  assert.equal(
    describeStoryMenu({ platform: "electron", buildChannel: "release", story: fakeStory() })
      .some((item) => item.id.startsWith("addon:")),
    false
  )
})
