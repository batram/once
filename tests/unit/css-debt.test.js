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
    "important|sample.css|body[data-platform=\"mobile\"] .toolbar|display: flex !important",
    "mobile-specificity-prefix|sample.css|body[data-platform=\"mobile\"] .toolbar|platform selector",
    "mobile-token-alias|sample.css|body[data-platform=\"mobile\"] .toolbar|--m-sp-2|occurrence:1",
    "mobile-token-alias|sample.css|body[data-platform=\"mobile\"] .toolbar|--m-sp-2|occurrence:2",
    "negative-margin|sample.css|body[data-platform=\"mobile\"] .toolbar|margin: 0 -2px",
    "raw-geometry-px|sample.css|body[data-platform=\"mobile\"] .toolbar|margin: 0 -2px"
  ])
})

// Keep detecting a negated guard even though completed ownership migrations
// should leave none in the repository.
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
    "desktop-specificity-prefix|sample.css|" +
      "body:not([data-platform=\"mobile\"]) .settings_actions .button|" +
      "platform selector"
  ])
})

test("CSS debt identities survive unrelated line movement", () => {
  const rule = ".legacy {\n  margin: -2px;\n}\n"
  assert.deepEqual(
    analyzeCss("sample.css", `/* moved */\n\n${rule}`),
    analyzeCss("sample.css", rule)
  )
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
        entry.startsWith(`raw-geometry-px|${file}|`)
      )) ||
    entry.startsWith("mobile-token-alias|")
  )
  assert.deepEqual(phaseOneDebt, [])
})
