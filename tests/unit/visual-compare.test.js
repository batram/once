"use strict"

const assert = require("node:assert/strict")
const path = require("node:path")
const test = require("node:test")
const {
  buildImageNames,
  parseArgs,
  reportHtml
} = require("../../scripts/visual-compare")

test("visual comparison defaults to building both real app targets", () => {
  const options = parseArgs([])
  assert.equal(options.build, true)
  assert.equal(options.electron, true)
  assert.equal(options.mobile, true)
})

test("visual comparison target and build switches compose", () => {
  const options = parseArgs([
    "--skip-build",
    "--electron-only",
    "--output",
    "artifacts/custom-visual"
  ])
  assert.equal(options.build, false)
  assert.equal(options.electron, true)
  assert.equal(options.mobile, false)
  assert.equal(
    options.output,
    path.resolve(__dirname, "../..", "artifacts/custom-visual")
  )
})

test("visual comparison rejects unsupported switches", () => {
  assert.throws(() => parseArgs(["--wat"]), /Unknown option: --wat/)
})

test("visual comparison covers both themes and every settings panel", () => {
  const names = buildImageNames(["electron", "mobile"])
  assert.equal(names.length, 60)
  for (const target of ["electron", "mobile"]) {
    for (const theme of ["light", "dark"]) {
      assert.ok(names.includes(`${target}-${theme}-stories.png`))
      assert.ok(names.includes(`${target}-${theme}-story-states.png`))
      assert.ok(names.includes(`${target}-${theme}-swipe-left-stage1.png`))
      assert.ok(names.includes(`${target}-${theme}-swipe-right-stage2.png`))
      assert.ok(names.includes(`${target}-${theme}-settings-index.png`))
      assert.ok(names.includes(`${target}-${theme}-reading.png`))
      for (const section of [
        "sources", "filters", "redirects", "sync", "theme",
        "swipe", "cache", "errors", "about"
      ]) {
        assert.ok(names.includes(
          `${target}-${theme}-settings-${section}.png`
        ))
      }
    }
  }
})

test("visual report supports keyboard-controlled comparison order", () => {
  const html = reportHtml({
    baseline: "baseline",
    imageNames: ["electron-light-stories.png"]
  })
  assert.match(html, /event\.key === "ArrowLeft"/)
  assert.match(html, /event\.key === "ArrowRight"/)
  assert.match(html, /class="previous"/)
  assert.match(html, /class="current"/)
  assert.match(html, /Current left, previous right/)
})
