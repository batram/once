const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

const {
  setSelectedUrl,
  toggledStoryUrl
} = require("../../../packages/ui-web/dist/story/selectedStoryToggle")
const { Story } = require("../../../packages/core/dist/story/Story")

const STORY_URL = "https://example.com/article"
const COMMENTS_URL = "https://news.example.com/item?id=1"

// The toggle only reads `.story` off the mirrored row, so a plain element
// carrying a real Story stands in for the custom element, as the cursor tests
// do. The Story itself is real: matches_comment_url and matches_story_url are
// the whole decision.
function withSelected(story, run) {
  const { window } = parseHTML(
    "<body><div id=\"selected_container\"></div></body>"
  )
  if (story) {
    const row = window.document.createElement("story-item")
    row.story = story
    window.document.querySelector("#selected_container").append(row)
  }
  try {
    return run(window.document)
  } finally {
    // Module state, shared across cases in this file.
    setSelectedUrl("")
  }
}

function storyWithComments(commentUrl = COMMENTS_URL) {
  return new Story("story", STORY_URL, "Example story", commentUrl)
}

test("the open story switches to its comments", () => {
  withSelected(storyWithComments(), (doc) => {
    setSelectedUrl(STORY_URL)
    assert.equal(toggledStoryUrl(doc), COMMENTS_URL)
  })
})

test("the open comments switch back to the story", () => {
  withSelected(storyWithComments(), (doc) => {
    setSelectedUrl(COMMENTS_URL)
    assert.equal(toggledStoryUrl(doc), STORY_URL)
  })
})

test("a story without comments has nothing to switch to", () => {
  withSelected(storyWithComments(""), (doc) => {
    setSelectedUrl(STORY_URL)
    assert.equal(toggledStoryUrl(doc), null)
  })
})

test("nothing happens without a selected story", () => {
  withSelected(null, (doc) => {
    setSelectedUrl(STORY_URL)
    assert.equal(toggledStoryUrl(doc), null)
  })
})

test("a page matching neither URL is left alone", () => {
  // The mirrored row lags the tab, or the user navigated on from the story.
  // Switching then would send them somewhere they never asked for.
  withSelected(storyWithComments(), (doc) => {
    setSelectedUrl("https://example.com/somewhere-else")
    assert.equal(toggledStoryUrl(doc), null)
  })
})

test("no known open URL means no switch", () => {
  withSelected(storyWithComments(), (doc) => {
    assert.equal(toggledStoryUrl(doc), null)
  })
})

test("a substory's comments count as the comments side", () => {
  withSelected(storyWithComments(), (doc) => {
    const substoryComments = "https://news.example.com/item?id=2"
    doc.querySelector("story-item").story.substories = [
      { comment_url: substoryComments }
    ]
    setSelectedUrl(substoryComments)
    assert.equal(toggledStoryUrl(doc), STORY_URL)
  })
})
