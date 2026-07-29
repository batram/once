const test = require("node:test")
const assert = require("node:assert/strict")

const {
  parseSourceGroups,
  serializeSourceGroups,
  parseFilterRows,
  parseRedirectRows,
  serializeRedirectRows
} = require("../../../packages/ui-web/dist/StructuredSettingsEditors")
const {
  createRedirectTester
} = require("../../../packages/ui-web/dist/structuredSettings/redirectTester")
const { parseHTML } = require("linkedom")

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

test("redirect tester seeds a matching URL and highlights exact captures", async () => {
  const { window } = parseHTML("<main></main>")
  const previous = {
    document: globalThis.document,
    window: globalThis.window
  }
  globalThis.document = window.document
  globalThis.window = window
  try {
    const pattern = window.document.createElement("textarea")
    pattern.value = "example\\.test/(same)/(.*)"
    const replacement = window.document.createElement("textarea")
    replacement.value = "mirror.test/$2/$1"
    const tester = createRedirectTester(pattern, replacement, [
      "https://example.test/same/value",
      "https://unmatched.test/article"
    ])
    window.document.querySelector("main").append(tester.element, tester.corpus)
    tester.refresh()
    await new Promise((resolve) => setTimeout(resolve, 150))

    const input = tester.element.querySelector("input")
    assert.equal(input.value, "https://example.test/same/value")
    assert.deepEqual(
      [...tester.element.querySelectorAll("mark")].map((mark) => mark.textContent),
      ["same", "value"]
    )
    assert.match(
      tester.element.querySelector(".structured_redirect_output").textContent,
      /mirror\.test\/value\/same/
    )
    assert.equal(tester.corpus.textContent, "Matches 1 of 2 loaded stories")
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(globalThis, name)
      else globalThis[name] = value
    }
  }
})

test("redirect tester reports invalid expressions without throwing", async () => {
  const { window } = parseHTML("<main></main>")
  const previous = {
    document: globalThis.document,
    window: globalThis.window
  }
  globalThis.document = window.document
  globalThis.window = window
  try {
    const pattern = window.document.createElement("textarea")
    pattern.value = "["
    const replacement = window.document.createElement("textarea")
    const tester = createRedirectTester(pattern, replacement, [])
    tester.refresh()
    await new Promise((resolve) => setTimeout(resolve, 150))

    assert.match(
      tester.element.querySelector(".structured_redirect_parse_error").textContent,
      /Invalid regular expression/
    )
    assert.equal(tester.corpus.textContent, "Matches 0 of 0 loaded stories")
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(globalThis, name)
      else globalThis[name] = value
    }
  }
})
