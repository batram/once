"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const {
  buildImageNames,
  historicalRunComplete,
  historicalRunName,
  parseArgs,
  reportHtml,
  structuralCollectorConfig,
  styleSnapshotName
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

test("visual comparison accepts a historical Git ref", () => {
  const options = parseArgs([
    "--ref",
    "HEAD~3",
    "--ref-only",
    "--electron-only"
  ])
  assert.equal(options.ref, "HEAD~3")
  assert.equal(options.refOnly, true)
  assert.equal(options.electron, true)
  assert.equal(options.mobile, false)
})

test("historical visual runs use full immutable commit ids", () => {
  const sha = "A".repeat(40)
  assert.equal(historicalRunName(sha), "a".repeat(40))
  assert.throws(() => historicalRunName("HEAD~1"), /Invalid commit SHA/)
})

test("complete historical runs can be reused", (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "once-visual-history-"))
  t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  const sha = "a".repeat(40)
  const names = ["electron-light-stories.png"]
  fs.writeFileSync(
    path.join(output, "manifest.json"),
    JSON.stringify({ sha })
  )
  fs.writeFileSync(path.join(output, names[0]), "")
  fs.writeFileSync(path.join(output, styleSnapshotName(names[0])), "{}")
  assert.equal(historicalRunComplete(output, names, sha), true)
  assert.equal(historicalRunComplete(output, names, "b".repeat(40)), false)
  fs.rmSync(path.join(output, styleSnapshotName(names[0])))
  assert.equal(historicalRunComplete(output, names, sha), false)
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
  assert.match(html, /current\/electron-light-stories\.styles\.json/)
})

test("visual report steps between samples with the vertical arrows", () => {
  const html = reportHtml({
    baseline: "baseline",
    imageNames: ["electron-light-stories.png", "electron-dark-stories.png"]
  })
  assert.match(html, /event\.key === "ArrowDown"/)
  assert.match(html, /event\.key === "ArrowUp"/)
  assert.match(html, /data-sample="electron-dark-stories"/)
  assert.match(html, /id="sample-status"/)
})

test("visual report can link a retained historical run", (t) => {
  const baseline = fs.mkdtempSync(path.join(os.tmpdir(), "once-visual-unit-"))
  t.after(() => fs.rmSync(baseline, { recursive: true, force: true }))
  fs.writeFileSync(path.join(baseline, "electron-light-stories.png"), "")
  fs.writeFileSync(
    path.join(baseline, "electron-light-stories.styles.json"),
    "{}"
  )
  const html = reportHtml({
    baseline,
    baselineHref: `runs/${"a".repeat(40)}`,
    baselineLabel: "HEAD~1 (aaaaaaaaaaaa)",
    imageNames: ["electron-light-stories.png"]
  })
  assert.match(html, /HEAD~1 \(aaaaaaaaaaaa\)/)
  assert.match(html, new RegExp(`src="runs/${"a".repeat(40)}/`))
})

test("visual screenshots have deterministic style companion names", () => {
  assert.equal(
    styleSnapshotName("mobile-dark-settings-theme.png"),
    "mobile-dark-settings-theme.styles.json"
  )
})

test("structural style collection is bounded around generated content", () => {
  assert.equal(structuralCollectorConfig.repeatLimit, 12)
  assert.equal(structuralCollectorConfig.maxElements, 500)
  assert.deepEqual(
    structuralCollectorConfig.excludedSubtrees,
    ["story-item", ".once-reader-host"]
  )
  assert.ok(structuralCollectorConfig.excludedTags.includes("SCRIPT"))
  assert.ok(structuralCollectorConfig.excludedTags.includes("STYLE"))
})
