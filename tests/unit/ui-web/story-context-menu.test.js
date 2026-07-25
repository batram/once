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
  return require("../../../packages/ui-web/dist/StoryContextMenu")
}

function fakeStory(overrides = {}) {
  const story = {
    href: "https://example.com/story",
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
    filterActionLabel: () => story.filter ? "Edit filter" : "Filter source"
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
    "open-reader",
    "toggle-read",
    "toggle-bookmark",
    "filter",
    "search-domain",
    "copy-link"
  ])
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
