const test = require("node:test")
const assert = require("node:assert/strict")

const {
  parseSourceGroups,
  serializeSourceGroups,
  parseFilterRows,
  parseRedirectRows,
  serializeRedirectRows
} = require("../../../packages/ui-web/dist/StructuredSettingsEditors")

test("story source groups round-trip order, duplicates, and empty groups", () => {
  const lines = [
    "https://one.test/",
    "*news",
    "geny:§§{\"stories\":{\"sel\":\"article\"}}§§https://two.test/",
    "https://two.test/",
    "*empty"
  ]
  assert.deepEqual(serializeSourceGroups(parseSourceGroups(lines)), lines)
})

test("filter rows preserve exact nonblank values, duplicates, and order", () => {
  assert.deepEqual(parseFilterRows("  first.test\n\nfirst.test\n second.test "), [
    "  first.test",
    "first.test",
    " second.test "
  ])
})

test("redirect rows preserve valid and malformed raw lines", () => {
  const text = [
    "https://one.test/(.*) => https://two.test/$1 => retained",
    "malformed redirect"
  ].join("\n")
  const rows = parseRedirectRows(text)
  assert.equal(rows[0].match_url, "https://one.test/(.*)")
  assert.equal(rows[0].replace_url, "https://two.test/$1 => retained")
  assert.equal(rows[1].invalid, true)
  assert.equal(serializeRedirectRows(rows), text)
})
