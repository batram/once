// Reproducible current-iOS evidence, kept separate from the historical mobile study.
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFileSync } = require("node:child_process")
const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length || sorted.some(value => !Number.isFinite(value))) throw new Error("Invalid metric samples")
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
}
const range = values => ({ median: median(values), min: Math.min(...values), max: Math.max(...values), n: values.length })
function validate(run) {
  if (run.schema !== 2 || !run.done || run.error || !run.runToken || !Number.isInteger(run.round)) throw new Error(`Incomplete run: ${run.file}`)
  if (run.mode === "rules") {
    if (run.rules?.length !== 12 || run.rules.some(sample => sample.error) || run.controls?.some(sample => !sample.compiled)) throw new Error("Rule compilation failed")
    return
  }
  if (run.mode === "filter-regression") {
    for (const key of ["blocked", "exceptionAllowed", "ordinaryAllowed", "cosmeticHidden", "cacheIdentifierStable", "invalidRejected", "stillBlockedAfterFailure", "emptyReturnsNil", "allowedAfterClearing", "cosmeticCleared", "emptyPreparation"]) {
      if (run[key] !== true) throw new Error(`Filter regression failed: ${key}`)
    }
    return
  }
  if (run.mode === "install") {
    if (!run.installations?.length || run.installations.some(sample => sample.error || !sample.loaded)) throw new Error("Install benchmark failed")
    return
  }
  if (run.pages?.length !== 4) throw new Error("Missing page samples")
  const count = Number(run.mode.match(/\d+$/)?.[0] || 0)
  const synthetic = /^(installed|matched)/.test(run.mode)
  const expectedCatalog = ["bare", "amo"].includes(run.mode) || run.mode.startsWith("scripts") ? 0 : 4 + (synthetic ? count : run.mode.startsWith("dnr") ? 1 : 0)
  if ((run.catalog?.length || 0) !== expectedCatalog || run.catalog?.some(row => row.disabledReason)) throw new Error("Invalid extension catalog")
  const bundledEnabled = run.mode === "all" ? 4 : ["blocker", "dark", "sponsor", "vm"].includes(run.mode) ? 1 : 0
  const installedEnabled = synthetic && !run.mode.includes("disabled") ? count : run.mode.startsWith("dnr") ? 1 : 0
  if ((run.catalog?.filter(row => row.enabled).length || 0) !== bundledEnabled + installedEnabled) throw new Error("Incorrect enabled extensions")
  if (Object.values(run.contextErrors || {}).some(errors => errors.length)) throw new Error("Native extension context reported errors")
  for (const page of run.pages) {
    if (!page.work || page.network?.bytes !== 1638400 || page.unexpectedScript !== false) throw new Error("Incomplete workload")
    if ((page.work.darkStyles > 0) !== ["all", "dark"].includes(run.mode)) throw new Error("Dark Reader state mismatch")
    if (page.matchedScripts !== (run.mode.startsWith("matched") ? count : 0)) throw new Error("Content-script execution mismatch")
    if (run.mode.startsWith("dnr") && page.dnrProbeBlocked !== (count > 0)) throw new Error("DNR block probe failed")
    for (const value of [page.navigationMs, page.network.elapsedMs, page.work.framesMs.p95, page.work.synchronousWorkMs.median]) {
      if (!Number.isFinite(value) || value < 0) throw new Error("Invalid page metric")
    }
  }
}
function summarize(runs) {
  const tokens = new Set()
  for (const run of runs) {
    validate(run)
    if (tokens.has(run.runToken)) throw new Error("Duplicate launch token")
    tokens.add(run.runToken)
  }
  const summary = {}
  for (const series of new Set(runs.map(run => run.series))) {
    const samples = runs.filter(run => run.series === series && run.round >= 0 && run.pages)
    summary[series] = {}
    for (const mode of new Set(samples.map(run => run.mode))) {
      const group = samples.filter(run => run.mode === mode)
      // A launch is the independent sampling unit; pages within it are correlated.
      const perLaunch = group.map(run => ({
        round: run.round, prepareMs: run.prepareMs,
        firstPageMs: run.prepareMs + run.surfaceCreationMs + run.pages[0].navigationMs,
        warmNavigationMs: median(run.pages.slice(1).map(page => page.navigationMs)),
        warmNetworkMs: median(run.pages.slice(1).map(page => page.network.elapsedMs)),
        frameP95Ms: median(run.pages.map(page => page.work.framesMs.p95)),
        synchronousWorkMs: median(run.pages.map(page => page.work.synchronousWorkMs.median)),
        appCPUms: run.appCPUms, appResidentMiB: run.appResidentMiB,
        ...(run.appPhysicalFootprintMiB === undefined ? {} : { appPhysicalFootprintMiB: run.appPhysicalFootprintMiB }),
        ...(run.appPeakPhysicalFootprintMiB === undefined ? {} : { appPeakPhysicalFootprintMiB: run.appPeakPhysicalFootprintMiB }),
        firstCatalogMs: run.firstCatalogMs ?? 0, cachedCatalogMs: run.cachedCatalogMs ?? 0,
        cachedPrepareMs: run.cachedPrepareMs ?? 0,
        ...(run.scriptRegistrationMs === undefined ? {} : { scriptRegistrationMs: run.scriptRegistrationMs })
      }))
      const stats = Object.fromEntries(Object.keys(perLaunch[0]).filter(key => key !== "round").map(key => [key, range(perLaunch.map(run => run[key]))]))
      const pages = group.flatMap(run => run.pages)
      summary[series][mode] = { launches: group.length, pages: pages.length, ...stats,
        framesOver25ms: pages.reduce((sum, page) => sum + page.work.framesOver25ms, 0), frameIntervals: pages.length * 89,
        thermalStates: [...new Set(group.flatMap(run => [run.thermalStart, run.thermalEnd]))],
        lowPowerRuns: group.filter(run => run.lowPower).length, perLaunch }
    }
    for (const [mode, value] of Object.entries(summary[series])) {
      const controlName = mode.startsWith("scripts") ? "scripts0" : mode.startsWith("dnr") ? "dnr0" : summary[series].bare ? "bare" : "disabled"
      const control = summary[series][controlName]
      if (control) {
        value.control = controlName
        value.pairedDeltaFromControl = {}
        for (const key of ["prepareMs", "firstPageMs", "warmNavigationMs", "warmNetworkMs", "synchronousWorkMs"]) {
          const deltas = value.perLaunch.flatMap(run => {
            const base = control.perLaunch.find(sample => sample.round === run.round)
            return base ? [run[key] - base[key]] : []
          })
          if (deltas.length) value.pairedDeltaFromControl[key] = range(deltas)
        }
      }
    }
  }
  return summary
}
function main() {
  const input = path.resolve(process.argv[2] || "artifacts/ios-extension-impact-20261026")
  const output = path.resolve(process.argv[3] || "docs/benchmarks/ios-extension-impact-2026-10-26.json")
  const runs = []
  for (const entry of fs.readdirSync(input, { withFileTypes: true })) {
    if (!entry.isDirectory() || ["pilot", "rejected"].includes(entry.name)) continue
    for (const file of fs.readdirSync(path.join(input, entry.name)).filter(file => /^ios--?\d+-.*\.json$/.test(file)).sort()) {
      runs.push({ file: `${entry.name}/${file}`, series: entry.name, ...JSON.parse(fs.readFileSync(path.join(input, entry.name, file), "utf8")) })
    }
  }
  if (!runs.length) throw new Error("No benchmark runs")
  const sources = {}
  for (const file of ["WebExtensionHost", "WebExtensionManagement", "WebExtensionInstaller", "ExtensionArchive", "ExtensionSupport", "AmoInstallBridge"]) {
    const name = `apps/mobile/ios/App/App/${file}.swift`
    sources[name] = crypto.createHash("sha256").update(fs.readFileSync(name)).digest("hex")
  }
  const bundles = {}
  for (const name of ["ublock-origin-lite", "ios/darkreader", "ios/sponsorblock", "ios/violentmonkey"]) {
    const directory = path.resolve("vendor/extensions", name)
    let files = 0, bytes = 0
    const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else { files++; bytes += fs.statSync(file).size }
    } }
    walk(directory)
    bundles[name] = { version: JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"))).version, files, bytes }
  }
  const evidence = {
    date: runs.map(run => run.started.slice(0, 10)).sort().at(-1),
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sources,
    environment: { device: "physical iPhone 16 Pro Max", os: [...new Set(runs.map(run => run.os))], build: "Xcode 26.6; Release Swift -O", bundleID: "com.zmarn.once.extensionbenchmark" },
    methodology: { conditioningRound: -1, samplingUnit: "fresh process launch; persistent extension state and OS caches retained", navigation: "real loopback HTTP; 4 pages per launch", fixture: "1500 paragraphs, 400 CSS rules; 1 s settling; 90 animation frames with 50 mutations and forced layout; then 100 x 16 KiB no-store fetches", firstPageMs: "prepare + surface creation + first didFinish; excludes catalog probes, process launch and Capacitor", summaries: "median/min/max of per-launch metrics; warm page metrics reduce pages 1–3 to a median within each launch; no independent-page statistical claim", memory: "UI process RSS only; excludes WebContent, extension and network processes", cpu: "UI process CPU only, includes in-process fixture server and catalog probes; not energy or total extension CPU" },
    summary: summarize(runs), bundles,
    ...(fs.existsSync(path.join(input, "builds.json")) ? { builds: JSON.parse(fs.readFileSync(path.join(input, "builds.json"), "utf8")) } : {}),
    ...(fs.existsSync(path.join(input, "native-host-results.json")) ? { nativeHostResults: JSON.parse(fs.readFileSync(path.join(input, "native-host-results.json"), "utf8")) } : {}),
    ...(fs.existsSync(path.join(input, "amo-bundle-analysis.json")) ? { amoBundleAnalysis: JSON.parse(fs.readFileSync(path.join(input, "amo-bundle-analysis.json"), "utf8")) } : {}),
    ...(fs.existsSync(path.join(input, "xpi-inputs.json")) ? { xpiInputs: JSON.parse(fs.readFileSync(path.join(input, "xpi-inputs.json"), "utf8")) } : {}),
    ...(fs.existsSync(path.join(input, "profiler-status.json")) ? { profiler: JSON.parse(fs.readFileSync(path.join(input, "profiler-status.json"), "utf8")) } : {}),
    rejectedRuns: fs.existsSync(path.join(input, "rejected")) ? fs.readdirSync(path.join(input, "rejected")).filter(file => /^ios-.*\.json$/.test(file)).map(file => ({ file, reason: "Conditioning batch abandoned: synthetic package manifest omitted description; corrected before measured scaling rounds", ...JSON.parse(fs.readFileSync(path.join(input, "rejected", file), "utf8")) })) : [],
    runs
  }
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n")
  console.log(JSON.stringify(Object.fromEntries(Object.entries(evidence.summary).map(([series, modes]) => [series, Object.fromEntries(Object.entries(modes).map(([mode, data]) => [mode, { launches: data.launches, prepare: data.prepareMs.median, first: data.firstPageMs.median, warm: data.warmNavigationMs.median, network: data.warmNetworkMs.median, work: data.synchronousWorkMs.median, rss: data.appResidentMiB.median }]))])), null, 2))
}
if (require.main === module) main()
module.exports = { median, validate, summarize }
