// Compare preserved baseline evidence with the follow-up native measurements.
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { createHash } = require("node:crypto")
const os = require("node:os")
const output = path.resolve("docs/benchmarks/mobile-extension-improvements.json")
execFileSync(process.execPath, ["scripts/summarize-mobile-extension-benchmark.js", "artifacts/extension-benchmark-after", output])
const read = file => JSON.parse(fs.readFileSync(file, "utf8"))
const evidence = read(output)
const baseline = read("docs/benchmarks/mobile-extension-impact.json")
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2, min: sorted[0], max: sorted.at(-1) }
}
const directory = "artifacts/extension-benchmark-selective"
const runs = fs.readdirSync(directory).filter(file => /^ios-\d+-all.json$/.test(file)).sort().map(file => ({ file, ...read(path.join(directory, file)) }))
for (const run of runs) {
  if (!run.done || run.error || run.pages?.length !== 4 || run.catalog.some(item => item.disabledReason) || run.pages.some(page => !page.work.darkStyles)) throw new Error(`Invalid selective startup sample: ${run.file}`)
}
evidence.summary.ios.all = {
  launches: runs.length,
  prepareMs: stats(runs.map(run => run.prepareMs)),
  firstFinishedMs: stats(runs.map(run => run.surfaceMs + run.pages[0].navigationMs)),
  warmNavigationMs: stats(runs.flatMap(run => run.pages.slice(1).map(page => page.navigationMs))),
  frameP95Ms: stats(runs.flatMap(run => run.pages.map(page => page.work.framesMs.p95)))
}
evidence.runs.push(...runs)
evidence.baseline = { revision: baseline.revision, summary: baseline.summary }
evidence.iosFilterRegression = read("artifacts/extension-benchmark-after/ios-filter-regression.json")
for (const key of ["done", "blocked", "exceptionAllowed", "ordinaryAllowed", "cosmeticHidden", "invalidRejected", "stillBlockedAfterFailure", "emptyReturnsNil", "allowedAfterClearing", "cosmeticCleared", "cacheIdentifierStable", "emptyPreparation"]) {
  if (evidence.iosFilterRegression[key] !== true) throw new Error(`Native regression failed: ${key}`)
}
evidence.iosExtensionBehavior = read("artifacts/extension-benchmark-after/ios-extension-behavior.json")
if (!evidence.iosExtensionBehavior.done || evidence.iosExtensionBehavior.errors?.length) throw new Error("Native extension behavior failed")
evidence.sourceState = "Uncommitted implementation changes on the recorded base revision"
evidence.sourceSHA256 = Object.fromEntries([
  "apps/mobile/extensions/once-surface/background.js", "apps/mobile/extensions/once-surface/filterRules.js",
  "apps/mobile/extensions/once-surface/manifest.json", "apps/mobile/ios/App/App/AppDelegate.swift",
  "apps/mobile/ios/App/App/InAppBrowserSurfacePlugin.swift",
  "apps/mobile/ios/App/App/ExtensionSupport.swift", "apps/mobile/ios/App/App/WebExtensionHost.swift"
].map(file => [file, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]))
evidence.methodology.ios = "Four fresh-process all-extension launches on Iphi, selective background loading with uBO readiness awaited. Same fixture and persistent-storage conditioning as baseline. Behavior suite separately run on iOS 26.5 simulator; filter regression on physical Iphi."
evidence.limitations = ["Sequential before/after sessions, not randomized paired trials; emulator host load varies.", "No physical Android or battery/energy measurements.", "iOS rule timings precede the final off-main-actor hash scheduling change; final native filter regression covers that change.", "Android generic and wildcard rules retain a linear fallback; domain benchmark does not establish arbitrary-list performance.", "No representative ad-heavy browsing, matching video performance, or full app startup measurement."]
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "once-benchmark-summary-"))
try {
  evidence.physicalAndroid = {}
  for (const version of ["baseline", "after"]) {
    const directory = `artifacts/extension-benchmark-physical-${version}`
    const destination = path.join(scratch, `${version}.json`)
    execFileSync(process.execPath, ["scripts/summarize-mobile-extension-benchmark.js", directory, destination])
    const result = read(destination)
    if (result.runs.length !== 16) throw new Error(`Expected 16 physical Android runs: ${version}`)
    const expectedVersion = version === "baseline" ? "1.1.0" : "1.1.1"
    if (result.runs.some(run => run.os !== "13" || run.catalog.some(item => item.id === "once-surface@zmarn.com" && item.version !== expectedVersion))) throw new Error(`Unexpected physical Android build: ${version}`)
    evidence.physicalAndroid[version] = { summary: result.summary.android, runs: result.runs }
  }
  evidence.physicalAndroid.environment = "Physical SM-G780G, Android 13, arm64, same GeckoView/debug harness. Wi-Fi ADB with reverse tunnel to host fixture; plugged in. Separate mode profiles, baseline then in-place update to fixed bridge, round 0 excluded in both."
  evidence.physicalAndroid.deviceConditions = Object.fromEntries([
    "artifacts/extension-benchmark-physical-baseline/thermal-start.txt",
    "artifacts/extension-benchmark-physical-baseline/thermal-end.txt",
    "artifacts/extension-benchmark-physical-baseline/battery-start.txt",
    "artifacts/extension-benchmark-physical-after/thermal-end.txt",
    "artifacts/extension-benchmark-physical-after/battery-end.txt"
  ].map(file => [path.relative("artifacts", file), fs.readFileSync(file, "utf8")]))
  evidence.limitations[1] = "Physical Android timing includes Wi-Fi ADB transport; controls and repeated batches are retained. No battery/energy measurements."
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n")
console.log(JSON.stringify(evidence.summary, null, 2))
