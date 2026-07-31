const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

const {
  searchableStoryElements
} = require("../../../packages/ui-web/dist/story/storySearchScope")

test("story search only selects stories in the main list", () => {
  const { document } = parseHTML(`
    <main id="stories"><article class="story" id="listed"></article></main>
    <section id="swipe_preview">
      <article class="story" id="preview"></article>
    </section>
  `)

  const stories = [...searchableStoryElements(document.querySelector("#stories"))]
  assert.deepEqual(stories.map((story) => story.id), ["listed"])
})
