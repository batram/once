const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const root = path.resolve(__dirname, "../docs/benchmarks")
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const lines = [
  "# Story ingestion benchmark", "",
  "Measured 2026-10-01 against the current compiled application and persistence code. No production ingestion behavior was changed.", "",
  `Host: ${os.platform()} ${os.arch()}, ${os.cpus()[0].model.trim()}, ${os.cpus().length} logical processors, ${Math.round(os.totalmem() / 1024 ** 3)} GiB RAM.`, "",
  "## Method", "",
  "Each trial starts with an open disposable database containing 10,000 historical stories. Batches contain distinct URLs, feed-like headlines, timestamps, comment URLs, and a source tag. Each source also receives its usual group tag through the actual AppRuntime.processStoryInput path. Five repetitions use separate databases. Six-source trials start their source ingestion together, representing coincident source-load completion. All source URLs are distinct; shared-URL serialization is not exercised.", "",
  "30 stories represents a front-page-sized batch; 100 and 300 represent larger feeds or aggregated sources. 1,000 per source is a stress case, not a claim about typical feed size. Data is synthetic and these sizes have not been calibrated against the user’s configured feeds.", "",
  "- Cold: new incoming URLs, with the historical archive already present. This is first ingestion, not cold process startup or an empty operating-system disk cache.",
  "- Warm unchanged: identical input immediately after cold ingestion, retaining the runtime working set.",
  "- Warm changed: same URLs with an additional tag, forcing a document update for every story.", "",
  "Timing covers filtering, group-tag insertion, bulk URL lookup, working-set merge, save completion, and synchronous event publication. It excludes database creation, archive seeding, input construction, feed fetch/parsing, UI rendering, replication, and content attachments. The platform uses fake settings/network/event consumers and the real story store and real database adapter.", "",
  "Peak database operations counts unresolved application-level get/put/allDocs promises; it does not count physical disk transactions or PouchDB’s internal calls. Timer lag is excess delay of a 10 ms interval and is indicative of event-loop pressure, not a measured UI frame time. Instrumentation adds some overhead.", ""
]
for (const [filename, title] of [["story-ingestion-indexeddb.json", "Chromium / IndexedDB"], ["story-ingestion-node.json", "Node / LevelDB baseline"]]) {
  const data = JSON.parse(fs.readFileSync(path.join(root, filename)))
  const expectedSamples = data.metadata.batchSizes.length * data.metadata.sourceCounts.length * data.metadata.repetitions * 3
  if (data.samples.length !== expectedSamples) throw new Error(`Incomplete run: ${filename}`)
  lines.push(`## ${title}`, "", data.metadata.adapter + ".", "",
    `Runtime: ${data.metadata.browser || data.metadata.node}. ${data.samples.length} timed samples.`, "",
    "| Stories/source | Sources | Total | Cold ms | Warm unchanged ms | Warm changed ms | Peak DB promises cold / changed |",
    "|---:|---:|---:|---:|---:|---:|---:|")
  for (const size of data.metadata.batchSizes) for (const sources of data.metadata.sourceCounts) {
    const rows = data.samples.filter(row => row.size === size && row.sources === sources)
    const phases = ["cold", "warm", "warmChanged"].map(phase => rows.filter(row => row.phase === phase))
    lines.push(`| ${size} | ${sources} | ${size * sources} | ${phases.map(rows => median(rows.map(row => row.elapsedMs)).toFixed(1)).join(" | ")} | ${Math.max(...phases[0].map(row => row.peakDb))} / ${Math.max(...phases[2].map(row => row.peakDb))} |`)
  }
  lines.push("", "Values are medians of five trials. Raw JSON retains each trial, operation counts, peak save concurrency, elapsed time and timer lag.", "",
    "| Six sources, stories/source | Phase | Min–max ms | Median timer lag ms | Maximum timer lag ms |",
    "|---:|---|---:|---:|---:|")
  for (const size of data.metadata.batchSizes) for (const phase of ["cold", "warm", "warmChanged"]) {
    const rows = data.samples.filter(row => row.size === size && row.sources === 6 && row.phase === phase)
    lines.push(`| ${size} | ${phase} | ${Math.min(...rows.map(row => row.elapsedMs)).toFixed(1)}–${Math.max(...rows.map(row => row.elapsedMs)).toFixed(1)} | ${median(rows.map(row => row.maxLagMs)).toFixed(1)} | ${Math.max(...rows.map(row => row.maxLagMs)).toFixed(1)} |`)
  }
  lines.push("")
}
lines.push("## Interpretation and limits", "",
  "Every cold or changed trial performs exactly one bulk lookup per source plus one document get and one document put per incoming story. Unchanged warm trials perform only the bulk lookups and no saves. Assertions check these counts and the final document count for every sample.", "",
  "The six-source limit does not bound per-story saves: the measured peak reaches the entire incoming story count for both adapters in every cold and changed configuration. A single 1,000-story source reaches 1,000 concurrent save promises, and six such sources reach 6,000. This establishes fan-out and its cost, but does not establish that a concurrency cap would be faster. A follow-up should compare a shared ingestion limit across all six sources against this baseline.", "",
  "In IndexedDB, six sources with 100 stories each take a median 1.03 seconds cold and 0.72 seconds with tag updates; at 300 each those values reach 2.84 and 2.08 seconds. The 6,000-story stress case takes 7.17 seconds cold and 9.67 seconds with updates, versus 0.40 seconds unchanged. Median maximum timer delay per trial reaches 533 ms cold and 419 ms with updates in that stress case. Results vary substantially: six-source 300-story cold trials range from 1.29 to 6.58 seconds. Treat these as host-specific baseline measurements rather than precise latency guarantees.", "",
  "IndexedDB results use the application’s auto_compaction=true and revs_limit=20 options in an isolated headless Chromium profile served from localhost. They exercise the same persistence adapter family as Electron, but exclude Electron integration and the rendered story list. Node uses default LevelDB options and is a supplemental baseline; cross-adapter timing differences also reflect these option and runtime differences.", "",
  "The archive size is fixed, so these measurements do not establish scaling with large user archives. Warm refreshes containing feed content, comment changes, duplicate URLs, or new stories can behave differently. Run a captured-feed workload and a bounded-concurrency comparison before choosing a production limit.", "",
  "## Reproduce", "", "```powershell", "npm run build:packages", "node scripts/benchmark-story-ingestion.js", "node scripts/benchmark-story-ingestion-browser.js", "node scripts/summarize-story-ingestion.js", "```", "",
  "On Windows, run unattended browser work using the hidden-desktop workflow. The browser runner uses an ephemeral profile and origin, destroys each benchmark database, removes its temporary bundle, and checkpoints JSON after every trial. User databases are never opened.", "",
  "## Harness issues encountered", "",
  "The first Node instrumentation attempt wrapped the live PouchDB instance, interfering with its internal callback calls and producing a 404/unhandled rejection. The corrected harness wraps only the store-facing database interface. The first browser bundle exposed PouchDB through a default export; the harness now handles both module export shapes. Both full corrected runs must succeed before this report is generated. Node also reports a dependency punycode deprecation warning; it does not fail the run.", "")
fs.writeFileSync(path.join(root, "story-ingestion.md"), lines.join("\n"))
console.log(path.join(root, "story-ingestion.md"))
