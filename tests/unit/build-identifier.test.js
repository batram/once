const assert = require("node:assert/strict")
const test = require("node:test")

const { devBuildIdentifier } = require("../../scripts/build-identifier")

test("creates a compact UTC dev build identifier", () => {
  assert.equal(
    devBuildIdentifier({}, new Date("2026-07-23T14:35:12.987Z")),
    "260723-143512"
  )
})

test("uses an explicitly assigned build identifier", () => {
  assert.equal(
    devBuildIdentifier({ ONCE_BUILD_ID: "4815" }),
    "4815"
  )
})
