const test = require("node:test")
const assert = require("node:assert/strict")
const { parseStorySourceText, serializeStorySourceDocument,
  serializeStorySourceDocumentWithRanges } = require(
  "../../../packages/core/dist/settings/storySourceText")

const doc = { version: 2, groups: [], sources: [
  { id: "src_00000001", url: "https://example.test/feed", label: "Example" }
] }

test("canonical source text keeps one source object per line", () => {
  const text = serializeStorySourceDocument(doc)
  assert.equal(text.split("\n").filter((line) => line.includes("src_00000001")).length, 1)
  assert.deepEqual(parseStorySourceText(text).doc, doc)
})

test("canonical source ranges resolve structurally by source id", () => {
  const second = { id: "src_00000002", url: "https://example.test/second" }
  const serialized = serializeStorySourceDocumentWithRanges({
    ...doc, sources: [...doc.sources, second]
  })
  const firstRange = serialized.sourceRanges.get("src_00000001")
  const secondRange = serialized.sourceRanges.get("src_00000002")
  assert.deepEqual(JSON.parse(serialized.text.slice(firstRange.start, firstRange.end)), doc.sources[0])
  assert.deepEqual(JSON.parse(serialized.text.slice(secondRange.start, secondRange.end)), second)
  assert.equal(serialized.sourceRanges.has("src_missing00"), false)
})

test("malformed JSON never falls through to legacy import", () => {
  const parsed = parseStorySourceText('{"version":2')
  assert.equal(parsed.ok, false)
  assert.equal(parsed.reports[0].path, "JSON")
})

test("an invalid legacy import rejects the whole input", () => {
  const parsed = parseStorySourceText("https://example.test/feed\nnot a url", doc)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.doc, undefined)
})

test("legacy import reconciliation preserves identity and omitted settings", () => {
  const parsed = parseStorySourceText("https://example.test/feed", doc)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.doc.sources[0].id, "src_00000001")
  assert.equal(parsed.doc.sources[0].label, "Example")
})
