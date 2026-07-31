const assert = require("node:assert/strict")
const test = require("node:test")
const {
  analyzeCss,
  compareDebt,
  currentDebt,
  findSingleUseWrappers,
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

test("a property declared and read once by the same rule is a wrapper", () => {
  const source = `
.card {
  --settings-card-padding: 15px;
  padding: var(--settings-card-padding);
}
`
  const [wrapper] = findSingleUseWrappers([["sample.css", source]])
  assert.equal(wrapper.selector, ".card")
  assert.equal(wrapper.name, "--settings-card-padding")
  assert.equal(wrapper.property, "padding")
})

test("a token read by another rule or another sheet is not a wrapper", () => {
  // Declared on the component, read by a descendant: the relationship the
  // wrapper shape only pretends to express.
  const descendant = `
.card { --card-inset: 35px; }
.card .body { padding-right: var(--card-inset); }
`
  assert.deepEqual(findSingleUseWrappers([["sample.css", descendant]]), [])

  // Read from a different stylesheet, which a per-file lint rule cannot see.
  assert.deepEqual(findSingleUseWrappers([
    ["a.css", ".card { --card-inset: 35px; }"],
    ["b.css", ".card .body { padding-right: var(--card-inset); }"]
  ]), [])

  // Read twice by the same rule expresses a real constraint between two
  // properties, so it is not a wrapper either.
  assert.deepEqual(findSingleUseWrappers([["sample.css", `
.field {
  --field-inset: 40px;
  width: calc(100% - var(--field-inset));
  padding-right: var(--field-inset);
}
`]]), [])
})

test("root-declared tokens and repeated selectors are handled correctly", () => {
  // :root is the public vocabulary, never a wrapper.
  assert.deepEqual(
    findSingleUseWrappers([["sample.css", `
:root { --sp-1: 4px; }
.card { padding: var(--sp-1); }
`]]),
    []
  )

  // The same selector inside a container query is a different rule, so
  // identity must not be matched on the selector text alone.
  const [only] = findSingleUseWrappers([["sample.css", `
.card { --a: 15px; padding: var(--a); }
@container (min-width: 20px) {
  .card { --b: 15px; }
}
.card { padding-top: var(--b); }
`]])
  assert.equal(only.name, "--a")
})

test("no single-use wrapper properties remain in tracked CSS", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const childProcess = require("node:child_process")
  const root = path.resolve(__dirname, "../..")
  const files = childProcess.execFileSync("git", ["ls-files", "*.css"], {
    cwd: root,
    encoding: "utf8"
  }).trim().split(/\r?\n/).filter(Boolean)
  const wrappers = findSingleUseWrappers(
    files.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")])
  )
  assert.deepEqual(wrappers.map((w) => `${w.file}:${w.line} ${w.name}`), [])
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
