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

// The negated guard is how a shared sheet says "desktop", and it went uncounted
// while being the larger half of the platform-branching debt.
test("CSS debt analysis counts the negated platform guard", () => {
  const source = `
body:not([data-platform="mobile"]) .settings_actions .button {
  color: red;
}

.unguarded {
  color: red;
}
`
  assert.deepEqual(analyzeCss("sample.css", source), [
    "desktop-specificity-prefix|sample.css:2|" +
      "body:not([data-platform=\"mobile\"]) .settings_actions .button"
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
