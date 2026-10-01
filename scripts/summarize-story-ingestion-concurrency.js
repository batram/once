const fs = require("node:fs")
const path = require("node:path")
const root = path.resolve(__dirname, "../docs/benchmarks")
const data = JSON.parse(fs.readFileSync(path.join(root, "story-ingestion-concurrency.json")))
const { metadata, samples } = data
const expected = metadata.batchSizes.length * metadata.sourceCounts.length * metadata.concurrencyLimits.length * metadata.repetitions * 3
if (samples.length !== expected) throw new Error(`Incomplete experiment: ${samples.length}/${expected}`)
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const rowsFor = (size, concurrency, phase) => {
  const rows = samples.filter(row => row.size === size && row.concurrency === concurrency && row.phase === phase)
  if (rows.length !== metadata.repetitions) throw new Error(`Incomplete group: ${size}/${concurrency}/${phase}`)
  return rows
}
const lines = ["# Shared story ingestion concurrency experiment", "",
  `Run started ${metadata.date}. ${samples.length} timed samples in Chromium ${metadata.browser}.`, "",
  "The actual AppRuntime ingestion path and PouchStoryStore run against PouchDB IndexedDB with LOCAL_POUCH_OPTIONS. An experimental FIFO gate wraps the complete addStory operation, using one gate per runtime shared across all six simultaneous source batches. The existing per-URL write queue remains in place. Bulk URL lookups remain outside the gate, so peak database promises can exceed the story limit by up to the number of source lookups.", "",
  "Strategies: unbounded, 16, 64, and 256 concurrent story operations. Five repetitions per strategy and size use separate disposable databases, each seeded with 10,000 historical stories. Strategy order rotates each repetition. The unbounded baseline is remeasured in the same run with the same instrumentation.", "",
  "Cold inserts new URLs; warm unchanged repeats them with the same runtime; warm changed adds one tag to every story. Synthetic batches contain distinct feed-like URLs, headlines, timestamps, comments and source/group tags. 30–300 stories per source represent front pages through larger feeds; 1,000 is a stress case. These sizes are not calibrated against configured feeds.", "",
  "Timing excludes feed fetch/parsing, input construction, database creation/seeding, rendering, replication and content attachments. Timer lag is the largest excess delay of a 10 ms interval per trial. It indicates event-loop pressure rather than actual UI frame latency. Chromium runs unattended on a hidden desktop with an ephemeral profile and localhost origin.", "",
  "## Median timings", "",
  "| Stories/source | Total | Shared limit | Cold ms | Warm unchanged ms | Warm changed ms |",
  "|---:|---:|---:|---:|---:|---:|"]
for (const size of metadata.batchSizes) for (const limit of metadata.concurrencyLimits) {
  lines.push(`| ${size} | ${size * 6} | ${limit ?? "unbounded"} | ${["cold", "warm", "warmChanged"].map(phase => median(rowsFor(size, limit, phase).map(row => row.elapsedMs)).toFixed(1)).join(" | ")} |`)
}
lines.push("", "## Throughput, event-loop pressure and observed concurrency", "",
  "Time change is relative to the freshly measured unbounded median at the same size and phase; negative means faster. Timer lag is the median of each trial’s maximum delay. Peaks are the maximum across five trials.", "",
  "| Stories/source | Phase | Limit | Time change | Min–max ms | Median max timer lag ms | Peak story operations | Peak saves | Peak DB promises |",
  "|---:|---|---:|---:|---:|---:|---:|---:|---:|")
for (const size of metadata.batchSizes) for (const phase of ["cold", "warm", "warmChanged"]) {
  const baseline = median(rowsFor(size, null, phase).map(row => row.elapsedMs))
  for (const limit of metadata.concurrencyLimits) {
    const rows = rowsFor(size, limit, phase)
    const times = rows.map(row => row.elapsedMs)
    lines.push(`| ${size} | ${phase} | ${limit ?? "unbounded"} | ${((median(times) / baseline - 1) * 100).toFixed(1)}% | ${Math.min(...times).toFixed(1)}–${Math.max(...times).toFixed(1)} | ${median(rows.map(row => row.maxLagMs)).toFixed(1)} | ${Math.max(...rows.map(row => row.peakStories))} | ${Math.max(...rows.map(row => row.peakSaves))} | ${Math.max(...rows.map(row => row.peakDb))} |`)
  }
}
lines.push("", "## Assessment", "",
  "A shared limit of 64 is the most promising balance among the tested values, rather than an established optimum. At 1,800 stories it reduces median cold/changed elapsed time by 11%/14% and median maximum timer lag by 75%/60%. At 6,000 stories it reduces median elapsed time by 11%/30% and timer lag by 73%/53%. At 600 stories it costs 13%/10% elapsed time while reducing timer lag by 80%/62%. At 180 stories throughput is close to unchanged and timer lag is lower.", "",
  "A limit of 16 has a large changed-ingestion slowdown at 600 stories and a cold slowdown in the stress case. A limit of 256 is slightly faster for changed ingestion in the stress-case median, but has a slower cold median and a changed-ingestion outlier of 21.8 seconds. The limit of 64 also has a cold stress outlier of 13.8 seconds, so none of these measurements demonstrates predictable tail latency. Five repetitions are sufficient for this exploratory comparison, not a statistically established production optimum.", "",
  "The story/save peak is 64 across all write-heavy configurations with the 64 strategy. Database-operation peaks reach 69 because other source bulk lookups can overlap those operations. Warm unchanged refreshes show little consistent benefit, and their bulk lookup/deserialization work remains outside the gate. A production implementation should target ingestion only, retain per-URL serialization, and validate mixed new/existing content and conflicts before rollout.", "",
  "## Validation and limits", "",
  "Every sample asserts one bulk lookup per source and one get/put per story for cold and changed ingestion, with no saves in unchanged warm ingestion. It checks final document count, an updated persisted tag, the story/save concurrency limit, and an empty drained gate. Build and syntax checks also passed.", "",
  "This tests the performance of a shared gate, not a production implementation. No production application source was modified. Warm unchanged operations do not necessarily yield to a browser task, so a promise gate alone cannot guarantee responsive rendering. Archive size is fixed; shared URLs, conflicts, content attachments and active replication need separate coverage before shipping a limiter. Timing variance and host load limit precise latency conclusions.", "",
  "## Reproduce", "", "```powershell", "npm run build:packages", "node scripts/benchmark-story-ingestion-browser.js --concurrency", "node scripts/summarize-story-ingestion-concurrency.js", "```", "",
  "Use the hidden-desktop workflow for unattended Windows browser runs. Raw results are checkpointed after each strategy/trial to story-ingestion-concurrency.json. The original unbounded benchmark artifacts are preserved.", "",
  "A progress-only diagnostic query had an extra closing parenthesis and was corrected. It did not affect the running benchmark. No benchmark assertion or runtime errors occurred in this experiment.", "")
fs.writeFileSync(path.join(root, "story-ingestion-concurrency.md"), lines.join("\n"))
console.log(path.join(root, "story-ingestion-concurrency.md"))
