const test = require("node:test")
const assert = require("node:assert/strict")
const { urlMatchParts } = require("../../packages/ui-web/dist/story/storyUrlMatch")

test("a URL match marks every occurrence, case-insensitively, keeping the URL's own case", () => {
  assert.deepEqual(urlMatchParts("https://Example.test/example", "example"), [
    { text: "https://", match: false },
    { text: "Example", match: true },
    { text: ".test/", match: false },
    { text: "example", match: true }
  ])
})

test("no needle or no occurrence is no match", () => {
  assert.equal(urlMatchParts("https://example.test/", ""), null)
  assert.equal(urlMatchParts("https://example.test/", "lobste"), null)
})

test("a match spanning the whole URL is one marked run", () => {
  assert.deepEqual(urlMatchParts("a.b", "A.B"), [{ text: "a.b", match: true }])
})
