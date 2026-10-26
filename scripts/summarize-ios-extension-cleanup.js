// Preserve the investigation baseline; summarize the focused follow-up separately.
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const assert = require("node:assert/strict")
const { median, validate, summarize } = require("./summarize-ios-extension-impact")
const input = path.resolve(process.argv[2] || "artifacts/ios-extension-cleanup-20261026")
const build = path.resolve(process.argv[3] || "/tmp/once-ios-extension-cleanup")
const output = path.resolve(process.argv[4] || "docs/benchmarks/ios-extension-cleanup-2026-10-26.json")
const readRuns = series => fs.readdirSync(path.join(input, series)).filter(file => /^ios--?\d+-.*\.json$/.test(file)).sort()
  .map(file => ({ file: `${series}/${file}`, series, ...JSON.parse(fs.readFileSync(path.join(input, series, file), "utf8")) }))
const diagnostics = readRuns("cache")
const browsing = readRuns("browsing")
const cacheRuns = diagnostics.filter(run => run.mode === "export-cache")
assert.equal(cacheRuns.length, 3)
const tokens = new Set()
for (const run of [...diagnostics, ...browsing]) {
  assert.equal(run.done, true)
  assert.equal(run.error, undefined)
  assert.ok(run.runToken && !tokens.has(run.runToken))
  tokens.add(run.runToken)
  if (run.mode === "export-cache") {
    assert.deepEqual(run.cacheSamples.map(sample => sample.count), [1000, 10000, 50000])
    for (const sample of run.cacheSamples) {
      assert.equal(sample.equal, true)
      assert.equal(sample.compiled, true)
      assert.equal(sample.cacheExisted, run.round > 0)
      for (const key of ["firstCachedExportMs", "uncachedExportMs", "repeatCachedExportMs"]) assert.ok(Number.isFinite(sample[key]) && sample[key] >= 0)
    }
  } else validate(run)
}
const cacheSummary = [1000, 10000, 50000].map(count => {
  const samples = cacheRuns.map(run => run.cacheSamples.find(sample => sample.count === count))
  const restartHits = samples.slice(1).map(sample => sample.firstCachedExportMs)
  return { count, jsonBytes: samples[0].jsonBytes, uncachedMedianMs: median(samples.map(sample => sample.uncachedExportMs)),
    firstMissMs: samples[0].firstCachedExportMs, restartHitMedianMs: median(restartHits), restartHitRangeMs: [Math.min(...restartHits), Math.max(...restartHits)],
    inProcessHitMedianMs: median(samples.map(sample => sample.repeatCachedExportMs)) }
})
const browsingSummary = summarize(browsing)
for (const mode of ["bare", "amo", "all"]) assert.equal(browsingSummary.browsing[mode].launches, 3)
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const sources = Object.fromEntries(["ExtensionSupport.swift", "WebExtensionHost.swift", "WebExtensionManagement.swift", "WebExtensionInstaller.swift", "InAppBrowserSurfacePlugin.swift"]
  .map(name => { const file = `apps/mobile/ios/App/App/${name}`; return [file, hash(file)] }))
const bundle = path.join(build, "public/amo-page-shim.js")
const baseline = JSON.parse(fs.readFileSync("docs/benchmarks/ios-extension-impact-2026-10-26.json", "utf8"))
const evidence = { date: cacheRuns[0].started.slice(0, 10), environment: baseline.environment,
  baseline: "ios-extension-impact-2026-10-26.json", sources,
  amoBundle: { beforeBytes: baseline.amoBundleAnalysis.testedBundle.bytes, afterBytes: fs.statSync(bundle).size, sha256: hash(bundle) },
  methodology: { cache: "Three fresh process launches; one persistent cache path per rule-count case to avoid evicting other cases. Production keeps one latest entry. Each launch compares cached output byte-for-byte with the uncached exporter and compiles it natively. Round 0 populates files; rounds 1–2 measure process-restart reuse. Simple domain rules differ from the baseline report's salted inputs; only compare matched-input timings here.",
    browsing: "Three retained launches plus one excluded conditioning launch per mode; same real HTTP four-page fixture as the baseline. Sequential sessions, not randomized before/after pairs.",
    lazyStartup: "Executed production settings method with a host getter that traps on initialization; no full-app startup timing claim.",
    cleanup: "Filesystem deletion and pruning use awaited detached tasks; no end-to-end removal speedup claimed." },
  cacheSummary, browsingSummary, nativeHostResults: JSON.parse(fs.readFileSync(path.join(input, "host-results.json"), "utf8")), runs: [...diagnostics, ...browsing] }
fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n")
console.log(JSON.stringify({ cacheSummary, amoBundle: evidence.amoBundle, browsing: Object.fromEntries(Object.entries(browsingSummary.browsing).map(([mode, data]) => [mode, { firstPageMs: data.firstPageMs.median, warmNavigationMs: data.warmNavigationMs.median, peakMiB: data.appPeakPhysicalFootprintMiB.median }])) }, null, 2))
