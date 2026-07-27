const test = require("node:test")
const assert = require("node:assert/strict")

test("installs with Firefox's menus namespace when contextMenus is absent", async () => {
  let installed
  let clicked
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
        addListener() {}
      },
      async sendMessage() {}
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
})
