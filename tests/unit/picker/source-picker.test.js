const test = require("node:test")
const assert = require("node:assert/strict")
const { parseDocument } = require("../../helpers/dom")
const {
  cssSegment,
  generalizeStorySelector,
  relativeFieldSelector
} = require("../../../packages/ui-web/dist/picker/sourcePicker")

const page = `<!doctype html><html><body>
  <main id="content">
    <div class="header"><a href="/about">About</a></div>
    <ul class="stories">
      <li class="story"><h2><a class="title" href="/one">One</a></h2><span class="tag">tools</span></li>
      <li class="story"><h2><a class="title" href="/two">Two</a></h2><span class="tag">games</span></li>
      <li class="story"><h2><a class="title" href="/three">Three</a></h2><span class="tag">news</span></li>
    </ul>
  </main>
</body></html>`

test("builds tag and class segments for elements", () => {
  const doc = parseDocument(page)
  assert.equal(cssSegment(doc.querySelector("li.story")), "li.story")
  assert.equal(cssSegment(doc.querySelector("ul")), "ul.stories")
  assert.equal(cssSegment(doc.querySelector("h2")), "h2")
})

test("generalizes a click on a title link to the outermost story container", () => {
  const doc = parseDocument(page)
  const clickedTitle = doc.querySelectorAll("a.title")[1]
  const selector = generalizeStorySelector(clickedTitle)
  assert.equal(selector, "li.story")
  assert.equal(doc.querySelectorAll(selector).length, 3)
})

test("generalizes a click on a tag to the repeating container with links", () => {
  const doc = parseDocument(page)
  const clickedTag = doc.querySelectorAll("span.tag")[0]
  const selector = generalizeStorySelector(clickedTag)
  assert.equal(selector, "li.story")
})

test("builds relative selectors that resolve to the picked element", () => {
  const doc = parseDocument(page)
  const story = doc.querySelectorAll("li.story")[1]
  const link = story.querySelector("a.title")
  const tag = story.querySelector("span.tag")

  const linkSelector = relativeFieldSelector(story, link)
  assert.equal(story.querySelectorAll(linkSelector)[0], link)

  const tagSelector = relativeFieldSelector(story, tag)
  assert.equal(story.querySelectorAll(tagSelector)[0], tag)

  assert.equal(relativeFieldSelector(story, story), null)
  assert.equal(relativeFieldSelector(story, doc.querySelector(".header a")), null)
})

test("disambiguates repeated siblings with nth-of-type", () => {
  const doc = parseDocument(`
    <div class="row">
      <span>first</span>
      <span>second</span>
      <span>third</span>
    </div>`)
  const row = doc.querySelector(".row")
  const second = row.querySelectorAll("span")[1]
  const selector = relativeFieldSelector(row, second)
  assert.equal(row.querySelectorAll(selector)[0], second)
  assert.match(selector, /nth-of-type\(2\)/)
})
