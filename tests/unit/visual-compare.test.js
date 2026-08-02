"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const settingsSectionDefinitions = require(
  "../../packages/ui-web/src/settings/settingsSectionDefinitions"
)
const {
  buildImageNames,
  historicalRunComplete,
  historicalRunName,
  parseArgs,
  publishHistoricalRun,
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

test("historical refresh is explicit", () => {
  const options = parseArgs(["--ref", "HEAD~3", "--refresh-ref"])
  assert.equal(options.refreshRef, true)
  assert.throws(
    () => parseArgs(["--refresh-ref"]),
    /--refresh-ref requires --ref REF/
  )
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
    JSON.stringify({
      sha,
      matrixVersion: 4,
      targets: ["electron"],
      imageNames: names
    })
  )
  fs.writeFileSync(path.join(output, names[0]), "")
  fs.writeFileSync(path.join(output, styleSnapshotName(names[0])), "{}")
  assert.equal(historicalRunComplete(output, sha, ["electron"]), true)
  assert.equal(
    historicalRunComplete(output, "b".repeat(40), ["electron"]),
    false
  )
  fs.rmSync(path.join(output, styleSnapshotName(names[0])))
  assert.equal(historicalRunComplete(output, sha, ["electron"]), false)
})

test("historical publication preserves existing runs by default", (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "once-visual-publish-"))
  t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  const runOutput = path.join(output, "retained")
  const stagedOutput = path.join(output, "staged")
  fs.mkdirSync(runOutput)
  fs.mkdirSync(stagedOutput)
  fs.writeFileSync(path.join(runOutput, "old.png"), "old")
  fs.writeFileSync(path.join(stagedOutput, "new.png"), "new")

  assert.throws(
    () => publishHistoricalRun(stagedOutput, runOutput, false),
    /will not be changed/
  )
  assert.equal(fs.readFileSync(path.join(runOutput, "old.png"), "utf8"), "old")
  assert.equal(fs.readFileSync(path.join(stagedOutput, "new.png"), "utf8"), "new")
})

test("explicit historical refresh publishes the staged run", (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "once-visual-refresh-"))
  t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  const runOutput = path.join(output, "retained")
  const stagedOutput = path.join(output, "staged")
  fs.mkdirSync(runOutput)
  fs.mkdirSync(stagedOutput)
  fs.writeFileSync(path.join(runOutput, "old.png"), "old")
  fs.writeFileSync(path.join(stagedOutput, "new.png"), "new")

  publishHistoricalRun(stagedOutput, runOutput, true)

  assert.equal(fs.existsSync(path.join(runOutput, "old.png")), false)
  assert.equal(fs.readFileSync(path.join(runOutput, "new.png"), "utf8"), "new")
})

test("visual comparison rejects unsupported switches", () => {
  assert.throws(() => parseArgs(["--wat"]), /Unknown option: --wat/)
})

test("visual comparison covers both themes and every settings panel", () => {
  const names = buildImageNames(["electron", "mobile"])
  assert.equal(names.length, 108)
  for (const target of ["electron", "mobile"]) {
    const settingsSections = settingsSectionDefinitions
      .filter(([, , , platform]) => !platform || platform === target)
      .map(([key]) => key)
    for (const theme of ["light", "dark"]) {
      assert.ok(names.includes(`${target}-${theme}-stories.png`))
      assert.ok(names.includes(`${target}-${theme}-story-states.png`))
      assert.ok(names.includes(`${target}-${theme}-notifications.png`))
      assert.ok(names.includes(`${target}-${theme}-swipe-left-stage1.png`))
      assert.ok(names.includes(`${target}-${theme}-swipe-right-stage2.png`))
      assert.ok(names.includes(`${target}-${theme}-settings-index.png`))
      assert.ok(names.includes(`${target}-${theme}-reading.png`))
      if (target === "electron") {
        assert.ok(names.includes(`${target}-${theme}-browser-content.png`))
      }
      for (const section of settingsSections) {
        assert.ok(names.includes(
          `${target}-${theme}-settings-${section}.png`
        ))
      }
      for (const state of [
        "search-results",
        "sources-structured",
        "sources-add-source",
        "sources-add-group",
        "filters-inline",
        "filters-validation",
        "filters-text",
        "redirects-editor",
        "redirects-text",
        "swipe-advanced"
      ]) {
        assert.ok(names.includes(
          `${target}-${theme}-settings-state-${state}.png`
        ))
      }
    }
  }
})

test("visual report supports keyboard-controlled comparison order", (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "once-visual-report-"))
  t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  const current = path.join(output, "current")
  fs.mkdirSync(current)
  fs.writeFileSync(path.join(current, "electron-light-stories.png"), "")
  fs.writeFileSync(
    path.join(current, "electron-light-stories.styles.json"),
    "{}"
  )
  const html = reportHtml({
    baseline: path.join(output, "baseline"),
    current,
    imageNames: ["electron-light-stories.png"]
  })
  assert.match(html, /event\.key === "ArrowLeft"/)
  assert.match(html, /event\.key === "ArrowRight"/)
  assert.match(html, /class="previous"/)
  assert.match(html, /class="current"/)
  assert.match(html, /Current left, previous right/)
  assert.match(html, /current\/electron-light-stories\.styles\.json/)
})

test("visual report retains samples present on only one side", (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "once-visual-union-"))
  t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  const baseline = path.join(output, "baseline")
  const current = path.join(output, "current")
  fs.mkdirSync(baseline)
  fs.mkdirSync(current)
  fs.writeFileSync(path.join(baseline, "electron-light-settings-old.png"), "")
  fs.writeFileSync(path.join(current, "electron-light-settings-new.png"), "")
  const html = reportHtml({
    baseline,
    current,
    imageNames: [
      "electron-light-settings-new.png",
      "electron-light-settings-old.png"
    ]
  })
  assert.match(html, /No previous run/)
  assert.match(html, /Not present in the current build/)
  assert.match(html, /current\/electron-light-settings-new\.png/)
  assert.match(html, /baseline\/electron-light-settings-old\.png/)
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
