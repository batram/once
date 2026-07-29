const assert = require("node:assert/strict")
const test = require("node:test")

const { logicalLines, functionEntries, fileViolations } = require("../../scripts/check-structure")

const noExceptions = { files: {}, functions: {} }

test("counts code lines and ignores comments of every shape", () => {
  const source = [
    "const a = 1",
    "",
    "// a line comment",
    "/**",
    " * a block comment",
    " */",
    "/* one line */",
    "const b = 2 // trailing",
    "const c = 3 /* trailing */"
  ].join("\n")
  assert.equal(logicalLines(source), 3)
})

test("counts a quoted comment opener as code", () => {
  const source = ['const glob = "/*"', "const kept = 1"].join("\n")
  assert.equal(logicalLines(source), 2)
})

test("names class members by their class", () => {
  const source = [
    "class Widget {",
    "  constructor() {}",
    "  render() {}",
    "  swipeable = () => {}",
    "}"
  ].join("\n")
  assert.deepEqual(
    functionEntries("packages/ui-web/src/Widget.ts", source).map((entry) => entry.key),
    [
      "packages/ui-web/src/Widget.ts#Widget.constructor",
      "packages/ui-web/src/Widget.ts#Widget.render",
      "packages/ui-web/src/Widget.ts#Widget.swipeable"
    ]
  )
})

test("names an assigned function by its assignment target", () => {
  const entries = functionEntries("scripts/build.js", "module.exports = (env) => {}")
  assert.deepEqual(entries.map((entry) => entry.key), ["scripts/build.js#module.exports"])
})

test("names a callback by the call that takes it", () => {
  const source = 'test("restores collapse after a drag", async () => {})'
  const entries = functionEntries("tests/e2e/mobile/mobile-web.spec.js", source)
  assert.deepEqual(entries.map((entry) => entry.key), [
    "tests/e2e/mobile/mobile-web.spec.js#test(restores collapse after a drag)"
  ])
})

test("falls back to a position when a call supplies no label", () => {
  const entries = functionEntries("packages/ui-web/src/rows.ts", "rows.map(() => {})")
  assert.deepEqual(entries.map((entry) => entry.key), [
    "packages/ui-web/src/rows.ts#<anonymous@1>"
  ])
})

test("keys an unnameable function by position so one entry cannot exempt the file", () => {
  const source = ["const handlers = [", "  () => {},", "  () => {}", "]"].join("\n")
  const entries = functionEntries("packages/ui-web/src/handlers.ts", source)
  assert.deepEqual(entries.map((entry) => entry.key), [
    "packages/ui-web/src/handlers.ts#<anonymous@2>",
    "packages/ui-web/src/handlers.ts#<anonymous@3>"
  ])
})

test("reports a function over the limit unless its own key is excepted", () => {
  const body = Array.from({ length: 130 }, (_, index) => `  const value${index} = ${index}`)
  const source = ["class Widget {", "  render() {", ...body, "  }", "}"].join("\n")
  const key = "packages/ui-web/src/Widget.ts#Widget.render"
  assert.deepEqual(fileViolations("packages/ui-web/src/Widget.ts", source, noExceptions), [
    `${key} is 132 lines (limit 120)`
  ])
  assert.deepEqual(
    fileViolations("packages/ui-web/src/Widget.ts", source, {
      files: {},
      functions: { [key]: "staged" }
    }),
    []
  )
})

test("does not charge a file's budget for its comments", () => {
  const comment = Array.from({ length: 40 }, () => " * why this state exists")
  const code = Array.from({ length: 590 }, (_, index) => `const value${index} = ${index}`)
  const source = ["/**", ...comment, " */", ...code].join("\n")
  assert.deepEqual(fileViolations("packages/ui-web/src/Wide.ts", source, noExceptions), [])
})
