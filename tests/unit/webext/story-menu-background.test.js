const test = require("node:test")
const assert = require("node:assert/strict")

test("installs with Firefox's menus namespace when contextMenus is absent", async () => {
  let installed
  let clicked
  let received
  let sent
  const created = []
  let removeAllCalls = 0
  const menus = {
    async removeAll() {
      removeAllCalls += 1
    },
    create(item) {
      created.push(item)
    },
    async update() {},
    onClicked: {
      addListener(listener) {
        clicked = listener
      }
    }
  }
  const browserApi = {
    menus,
    runtime: {
      getURL: (path) => `moz-extension://once${path}`,
      onInstalled: {
        addListener(listener) {
          installed = listener
        }
      },
      onMessage: {
        addListener(listener) {
          received = listener
        }
      },
      async sendMessage(message) {
        sent = message
      }
    }
  }

  const { installStoryMenuBackground } = require(
    "../../../packages/webext-shell/dist/storyMenuBackground"
  )
  installStoryMenuBackground(browserApi)

  assert.equal(typeof installed, "function")
  assert.equal(typeof clicked, "function")
  installed()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(removeAllCalls, 1)
  assert.ok(created.some((item) => item.id === "once_story_open-comments"))
  assert.ok(created.some((item) => item.id === "once_story_undo"))
  assert.ok(created.every((item) =>
    item.documentUrlPatterns[0].startsWith("moz-extension://once/")
  ))

  received({
    onceCommand: "story-menu-context",
    contextId: "panel-a",
    items: []
  })
  clicked({ menuItemId: "once_story_undo", targetElementId: 42 })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(sent, {
    onceCommand: "story-menu-action",
    action: "undo",
    contextId: "panel-a",
    targetElementId: 42
  })
})

test("only the side panel that opened the menu handles its action", () => {
  const { isStoryMenuActionForContext } = require(
    "../../../packages/webext-shell/dist/storyMenuBackground"
  )
  const message = {
    onceCommand: "story-menu-action",
    action: "undo",
    contextId: "panel-a"
  }

  assert.equal(isStoryMenuActionForContext(message, "panel-a"), true)
  assert.equal(isStoryMenuActionForContext(message, "panel-b"), false)
})
