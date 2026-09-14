const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { installRawAssetLoader } = require("../../helpers/raw-assets")

// Mirrors what the webext platform reports while a tab opens: activation
// sees the tab still on about:blank, and the real URL follows once it loads.
// The miss walks the store and the working set; the hit is immediate.
function loadModule() {
  const { window } = parseHTML('<html><body><div id="selected_container"></div></body></html>')
  globalThis.window = window
  globalThis.document = window.document
  globalThis.Element = window.Element
  globalThis.HTMLElement = window.HTMLElement
  globalThis.customElements = window.customElements
  globalThis.MouseEvent = window.MouseEvent
  globalThis.Event = window.Event
  // linkedom exposes innerText read-only; the row writes its title through it.
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() { return this.textContent },
    set(value) { this.textContent = value }
  })
  installRawAssetLoader()
  const { Story } = require("../../../packages/core/dist/story/Story")
  const { updateSelectedStory } = require("../../../packages/ui-web/dist/story/selectedStory")
  return { window, Story, updateSelectedStory }
}

const STORY_URL = "http://127.0.0.1:1/story/alpha"
const CONVERSATION_URL = `moz-extension://x/static/addon-conversation.html?story=${encodeURIComponent(STORY_URL)}`

function selectedHref() {
  return document.querySelector("#selected_container story-item")?.story.href ?? null
}

test("a late miss cannot wipe the selection a newer URL already made", async () => {
  const { Story, updateSelectedStory } = loadModule()
  const alpha = new Story("fixture", STORY_URL, "Alpha", STORY_URL)
  let releaseMiss
  const client = {
    findStoryByUrl: (url) => url === STORY_URL
      ? Promise.resolve(alpha)
      : new Promise((resolve) => { releaseMiss = () => resolve(null) })
  }
  const conversations = {
    storyHref: (url) => url.startsWith("moz-extension://") ? new URL(url).searchParams.get("story") : null
  }

  const stale = updateSelectedStory(client, "about:blank", conversations)
  await updateSelectedStory(client, CONVERSATION_URL, conversations)
  assert.equal(selectedHref(), STORY_URL)

  releaseMiss()
  await stale
  assert.equal(selectedHref(), STORY_URL, "the older about:blank lookup must not clear the newer selection")
})

test("the newest URL wins even when it is the one that misses", async () => {
  const { Story, updateSelectedStory } = loadModule()
  const alpha = new Story("fixture", STORY_URL, "Alpha", STORY_URL)
  let releaseHit
  const client = {
    findStoryByUrl: (url) => url === STORY_URL
      ? new Promise((resolve) => { releaseHit = () => resolve(alpha) })
      : Promise.resolve(null)
  }

  const older = updateSelectedStory(client, STORY_URL)
  await updateSelectedStory(client, "https://example.com/elsewhere")
  releaseHit()
  await older
  assert.equal(selectedHref(), null, "a stale hit must not select a story the browser has already left")
})

test("a contributed element that depends on where the row lives sees the mirror, not a detached row", async () => {
  const { Story, updateSelectedStory } = loadModule()
  const { registerStoryElement } = require("../../../packages/ui-web/dist/story/storyElements")
  const alpha = new Story("fixture", STORY_URL, "Alpha", STORY_URL)
  const client = { findStoryByUrl: (url) => Promise.resolve(url === STORY_URL ? alpha : null) }
  // Stands in for an addon tray whose open state is kept per place: it renders
  // only for the row mirrored into #selected_container.
  const release = registerStoryElement({
    id: "test:mirror-tray", slot: "tray",
    render: (row) => {
      if (!row.closest("#selected_container")) return null
      const tray = document.createElement("section")
      tray.className = "addon_tray"
      return tray
    }
  })
  try {
    await updateSelectedStory(client, STORY_URL)
    assert.equal(selectedHref(), STORY_URL)
    assert.equal(document.querySelectorAll("#selected_container .addon_tray").length, 1, "the tray belongs to the mirrored row once it is in place")
    // Leaving for another page and coming back rebuilds the mirror; the tray is there again.
    await updateSelectedStory(client, "https://example.com/elsewhere")
    assert.equal(selectedHref(), null)
    await updateSelectedStory(client, STORY_URL)
    assert.equal(document.querySelectorAll("#selected_container .addon_tray").length, 1)
  } finally { release() }
})
