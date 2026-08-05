const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { serializeStorySourceDocument } = require("../../../packages/core/dist")
const { highlightStorySourceTextarea } = require(
  "../../../packages/ui-web/dist/settings/textareaHighlight")

const source = {
  id: "src_00000001",
  url: "https://example.test/feed",
  label: "Example"
}

test("source-id navigation selects its canonical object in text mode", () => {
  const { window } = parseHTML('<textarea id="sources_area"></textarea>')
  const previousDocument = globalThis.document
  const previousAnimationFrame = globalThis.requestAnimationFrame
  globalThis.document = window.document
  globalThis.requestAnimationFrame = () => 0
  try {
    const textarea = window.document.querySelector("#sources_area")
    textarea.setSelectionRange = (start, end) => {
      textarea.selectionStart = start
      textarea.selectionEnd = end
    }
    textarea.value = serializeStorySourceDocument({
      version: 2,
      groups: [],
      sources: [source]
    })
    assert.equal(highlightStorySourceTextarea(source.id), true)
    assert.deepEqual(
      JSON.parse(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)),
      source
    )
  } finally {
    globalThis.document = previousDocument
    globalThis.requestAnimationFrame = previousAnimationFrame
  }
})

test("source-id navigation refuses noncanonical text instead of guessing", () => {
  const { window } = parseHTML('<textarea id="sources_area"></textarea>')
  const previousDocument = globalThis.document
  globalThis.document = window.document
  try {
    const textarea = window.document.querySelector("#sources_area")
    textarea.value = JSON.stringify({ version: 2, groups: [], sources: [source] })
    assert.equal(highlightStorySourceTextarea(source.id), false)
    assert.equal(textarea.selectionStart, textarea.selectionEnd)
  } finally {
    globalThis.document = previousDocument
  }
})
