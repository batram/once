const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { Story } = require("../../../packages/core/dist")
const { AppRuntime } = require("../../../packages/app/dist/AppRuntime")
const { createFakePlatform } = require("../../helpers/fake-platform")
require("../../helpers/raw-assets").installRawAssetLoader()

test("the bookmark button sends a real transition before the app's no-op check", async t => {
  const { window } = parseHTML("<html><body></body></html>")
  for (const key of ["window", "document", "Element", "HTMLElement", "customElements", "MouseEvent", "Event", "CustomEvent"]) {
    const previous = globalThis[key]
    globalThis[key] = key === "window" ? window : window[key]
    t.after(() => { globalThis[key] = previous })
  }
  const { StoryListItem } = require("../../../packages/ui-web/dist/story/StoryListItem")
  const { setOnceClient } = require("../../../packages/ui-web/dist/client")
  const story = new Story("RSS", "https://example.test/bookmark", "Bookmark")
  const fake = createFakePlatform([story]), app = new AppRuntime(fake.ports)
  setOnceClient(app.client)
  const row = { story, star_btn: document.createElement("button") }
  StoryListItem.prototype.toggleBookmark.call(row)
  await app.client.settledStoryWrites()
  assert.equal((await fake.ports.storyStore.getStory(story.href)).stared, true)
  assert.ok(story.sync_updated_at.stared > 0)
  StoryListItem.prototype.toggleBookmark.call(row)
  await app.client.settledStoryWrites()
  assert.equal((await fake.ports.storyStore.getStory(story.href)).stared, false)
})
