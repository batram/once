const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { Story } = require("../../../packages/core/dist")
const { AppRuntime } = require("../../../packages/app/dist/AppRuntime")
const { createFakePlatform } = require("../../helpers/fake-platform")
require("../../helpers/raw-assets").installRawAssetLoader()

test("a story update leaves body[animated], the animation setting, alone", async t => {
  const { window } = parseHTML('<html><body animated="false"></body></html>')
  for (const key of ["window", "document", "Element", "HTMLElement", "customElements", "Event", "CustomEvent"]) {
    const previous = globalThis[key]
    globalThis[key] = key === "window" ? window : window[key]
    t.after(() => { globalThis[key] = previous })
  }
  const { StoryListItem } = require("../../../packages/ui-web/dist/story/StoryListItem")
  const { DataChangeEvent } = require("../../../packages/ui-web/dist/story/storyList")
  const story = new Story("RSS", "https://example.test/animated", "Animated")
  const row = { animated: false, story, update_complete_story_el() {} }
  // The backend still reported the old setting, as it did while a save was pending.
  StoryListItem.prototype.update_story_el.call(row, new DataChangeEvent("data_change", {
    story, path: [story.href], value: story, previousValue: story, name: null, animated: true
  }))
  assert.equal(row.animated, true)
  assert.equal(document.body.getAttribute("animated"), "false")
})

test("the app reports a new animation setting before its save finishes", async () => {
  const fake = createFakePlatform([])
  const app = new AppRuntime(fake.ports)
  const saving = app.client.setAnimation(false)
  assert.equal(app.settings.animated, false)
  await saving
  assert.equal(await app.client.getAnimation(), false)
})
