// Rebuilds the checked-in evidence from raw native benchmark results.
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const input = path.resolve(process.argv[2] || "artifacts/extension-benchmark")
const output = path.resolve(process.argv[3] || "docs/benchmarks/mobile-extension-impact.json")
const median = values => {
  const a = [...values].sort((x, y) => x - y)
  return (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2
}
const range = values => ({ median: median(values), min: Math.min(...values), max: Math.max(...values) })
const runs = fs.readdirSync(input).filter(file => /^(ios|android)-\d+-.*\.json$/.test(file)).sort().map(file => {
  const data = JSON.parse(fs.readFileSync(path.join(input, file), "utf8"))
  const platform = file.startsWith("ios") ? "ios" : "android"
  if (data.error || (platform === "ios" && !data.done)) throw new Error(`Failed sample: ${file}`)
  const pages = platform === "ios" ? data.pages : data.fixturePages
  if (pages?.length !== 4 || pages.some(page => !page.work || page.error)) throw new Error(`Incomplete fixture: ${file}`)
  if (platform === "ios") {
    const dark = data.mode === "all" || data.mode === "dark"
    if (pages.some(page => (page.work.darkStyles > 0) !== dark || (page.unexpectedScript !== undefined && page.unexpectedScript !== false))) throw new Error(`Unexpected content script state: ${file}`)
    if (data.catalog?.some(item => item.disabledReason)) throw new Error(`Extension failure: ${file}`)
  } else {
    if (!data.totalPssKiB || pages.some(page => page.network.bytes !== 1638400)) throw new Error(`Invalid memory/traffic sample: ${file}`)
    const count = data.mode === "bare" ? 0 : data.mode === "all" ? 3 : ["blocker", "vm"].includes(data.mode) ? 2 : 1
    if (data.catalog.length !== count || data.catalog.some(item => !item.enabled)) throw new Error(`Unexpected extension catalog: ${file}`)
  }
  return { file, platform, ...data, catalog: data.catalog?.map(({ id, version, enabled, disabledReason }) => ({ id, version, enabled, disabledReason })) }
})
const summary = { ios: {}, android: {} }
for (const platform of ["ios", "android"]) {
  for (const mode of new Set(runs.filter(run => run.platform === platform).map(run => run.mode))) {
    // Android round 0 conditions the per-mode profile; its samples remain in runs.
    const samples = runs.filter(run => run.platform === platform && run.mode === mode && (platform !== "android" || run.round > 0))
    if (!samples.length) continue
    const pages = samples.flatMap(run => platform === "ios" ? run.pages : run.fixturePages)
    const work = pages.map(page => page.work)
    const common = { launches: samples.length, pages: pages.length, prepareMs: range(samples.map(run => run.prepareMs)),
      frameP95Ms: range(work.map(page => page.framesMs.p95)), framesOver25ms: work.reduce((sum, page) => sum + page.framesOver25ms, 0), frameIntervals: work.length * 89 }
    summary[platform][mode] = platform === "ios" ? {
      ...common,
      firstFinishedMs: range(samples.map(run => run.surfaceMs + run.pages[0].navigationMs)),
      warmNavigationMs: range(samples.flatMap(run => run.pages.slice(1).map(page => page.navigationMs))),
      ...(samples[0].scriptRegistrationMs !== undefined ? { scriptRegistrationMs: range(samples.map(run => run.scriptRegistrationMs)) } : {})
    } : {
      ...common,
      readyMs: range(samples.map(run => run.readyMs)),
      totalPssMiB: range(samples.map(run => run.totalPssKiB / 1024)),
      network100RequestsMs: range(pages.map(page => page.network.elapsedMs)),
      warmNetwork100RequestsMs: range(samples.flatMap(run => run.fixturePages.slice(1).map(page => page.network.elapsedMs))),
      warmNavigationMs: range(samples.flatMap(run => run.fixturePages.slice(1).map(page => page.navigation.duration)))
    }
  }
}
const bundles = {}
for (const name of ["ublock-origin", "violentmonkey", "ublock-origin-lite", "ios/darkreader", "ios/sponsorblock", "ios/violentmonkey"]) {
  let bytes = 0, files = 0
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else { files++; bytes += fs.statSync(full).size }
    }
  }
  walk(path.resolve("vendor/extensions", name))
  bundles[name] = { files, bytes }
}
const evidence = {
  date: "2026-10-04", revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  environment: { ios: "iPhi, physical iPhone 16 Pro Max, iOS 27.0.1, Release Swift -O", android: "Android 16 API 36 arm64 emulator, GeckoView 155.0.20260903215306, debug harness", host: "Apple M4 Pro, macOS 26.6.2" },
  methodology: { ios: "Four fresh-process launches per extension mode, persistent storage preconditioned; four HTML-string page loads per launch. Userscript modes have three launches.", android: "Four fresh-process launches per mode using separate persistent Gecko profiles. Round 0 excluded from summaries; retained in raw runs. Four HTTP fixture loads per launch; 100 concurrent 16 KiB fetches per page; process-group PSS snapshot afterward.", fixture: "1500 paragraphs, 400 CSS rules; 1 second settling then 90 animation frames, 50 DOM mutations and one layout read per frame. No installed VM scripts, no SponsorBlock video match, no third-party ad requests. Figures are not cross-platform comparisons or full Once app launch timings." },
  summary, bundles, iosRules: fs.existsSync(path.join(input, "ios-rules.json")) ? JSON.parse(fs.readFileSync(path.join(input, "ios-rules.json"), "utf8")) : null, runs
}
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n")
console.log(JSON.stringify(summary, null, 2))
