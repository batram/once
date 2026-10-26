const test = require("node:test")
const assert = require("node:assert/strict")
const { median, validate, summarize } = require("../../../scripts/summarize-ios-extension-impact")
function sample(round = 0) {
  return {
    schema: 2, done: true, runToken: `token-${round}`, series: "test", round, mode: "bare",
    prepareMs: 1, surfaceCreationMs: 2, appCPUms: 10, appResidentMiB: 20, thermalStart: 0, thermalEnd: 0, lowPower: false,
    pages: [0, 1, 2, 3].map(index => ({ index, navigationMs: [100, 3, 4, 5][index],
      network: { bytes: 1638400, elapsedMs: 20 }, unexpectedScript: false, matchedScripts: 0,
      work: { darkStyles: 0, framesMs: { p95: 17 }, synchronousWorkMs: { median: 2 }, framesOver25ms: 0 }
    }))
  }
}
test("summary excludes conditioning and treats a launch as the sample unit", () => {
  const warmup = sample(-1)
  warmup.prepareMs = 999
  const second = sample(1)
  second.pages[1].navigationMs = 1000
  const result = summarize([warmup, sample(), second]).test.bare
  assert.equal(result.launches, 2)
  assert.equal(result.prepareMs.median, 1)
  assert.equal(result.firstPageMs.median, 103)
  assert.equal(result.warmNavigationMs.median, 4.5)
  assert.equal(result.warmNavigationMs.n, 2)
  assert.equal(result.frameIntervals, 712)
})
test("median rejects missing and nonfinite metrics", () => {
  assert.throws(() => median([]), /Invalid/)
  assert.throws(() => median([NaN]), /Invalid/)
  assert.equal(median([4, 1, 3, 2]), 2.5)
})
test("duplicate launch evidence is rejected", () => {
  assert.throws(() => summarize([sample(), sample()]), /Duplicate/)
})
test("unfinished, stale-schema and failed launches are rejected", () => {
  for (const patch of [{ done: false }, { schema: 1 }, { error: "timeout" }, { runToken: "" }]) {
    assert.throws(() => validate({ ...sample(), ...patch }), /Incomplete/)
  }
})
test("missing traffic or falsely inactive scripts cannot count as successful workload", () => {
  for (const mutate of [
    run => run.pages.pop(),
    run => { run.pages[0].network.bytes = 0 },
    run => { run.pages[0].unexpectedScript = "yes" },
    run => { run.pages[0].matchedScripts = 10 },
    run => { run.pages[0].work.darkStyles = 4 },
    run => { run.contextErrors = { extension: ["Rule compilation failed"] } },
    run => { run.pages[0].navigationMs = NaN }
  ]) {
    const run = sample(); mutate(run)
    assert.throws(() => validate(run))
  }
})
test("incorrect enabled state and catalog failures are rejected", () => {
  const run = { ...sample(), mode: "disabled", catalog: Array.from({ length: 4 }, () => ({ enabled: false, disabledReason: "" })) }
  validate(run)
  run.catalog[0].enabled = true
  assert.throws(() => validate(run), /enabled/)
  run.catalog[0].enabled = false
  run.catalog[0].disabledReason = "bad extension"
  assert.throws(() => validate(run), /catalog/)
})
