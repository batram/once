const assert = require("node:assert/strict")
const test = require("node:test")
const {
  analyzeCss,
  compareDebt,
  currentDebt,
  phaseOneMigratedScopes
} = require("../../scripts/check-css-debt")

test("CSS debt analysis identifies the guarded debt categories", () => {
  const source = `
body[data-platform="mobile"] .toolbar {
  --m-sp-2: 8px;
  margin: 0 -2px;
  padding: var(--m-sp-2);
  display: flex !important;
}
`
  assert.deepEqual(analyzeCss("sample.css", source), [
    "important|sample.css:6|display: flex !important",
    "mobile-specificity-prefix|sample.css:2|body[data-platform=\"mobile\"] .toolbar",
    "mobile-token-alias|sample.css:3|--m-sp-2",
    "mobile-token-alias|sample.css:5|--m-sp-2",
    "negative-margin|sample.css:4|margin: 0 -2px",
    "raw-geometry-px|sample.css:4|margin: 0 -2px"
  ])
})

test("CSS debt comparison reports both additions and stale baseline entries", () => {
  assert.deepEqual(compareDebt(["kept", "removed"], ["kept", "added"]), {
    added: ["added"],
    removed: ["removed"]
  })
})

test("completed Phase 1 scopes contain no raw geometry or mobile aliases", () => {
  const phaseOneDebt = currentDebt().filter((entry) =>
    (entry.startsWith("raw-geometry-px|") &&
      phaseOneMigratedScopes.some((file) =>
        entry.startsWith(`raw-geometry-px|${file}:`)
      )) ||
    entry.startsWith("mobile-token-alias|")
  )
  assert.deepEqual(phaseOneDebt, [])
})
