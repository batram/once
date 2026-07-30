const assert = require("node:assert/strict")
const test = require("node:test")
const { analyzeCss, compareDebt } = require("../../scripts/check-css-debt")

test("CSS debt analysis identifies the guarded debt categories", () => {
  const source = `
body[data-platform="mobile"] .toolbar {
  margin: 0 -2px;
  padding: 12px;
  display: flex !important;
}
`
  assert.deepEqual(analyzeCss("sample.css", source), [
    "important|sample.css:5|display: flex !important",
    "mobile-specificity-prefix|sample.css:2|body[data-platform=\"mobile\"] .toolbar",
    "negative-margin|sample.css:3|margin: 0 -2px",
    "raw-geometry-px|sample.css:3|margin: 0 -2px",
    "raw-geometry-px|sample.css:4|padding: 12px"
  ])
})

test("CSS debt comparison reports both additions and stale baseline entries", () => {
  assert.deepEqual(compareDebt(["kept", "removed"], ["kept", "added"]), {
    added: ["added"],
    removed: ["removed"]
  })
})
