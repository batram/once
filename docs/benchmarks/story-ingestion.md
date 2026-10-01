# Story ingestion benchmark

Measured 2026-10-01 against the current compiled application and persistence code. No production ingestion behavior was changed.

Host: win32 x64, AMD Ryzen 9 5900X 12-Core Processor, 24 logical processors, 64 GiB RAM.

## Method

Each trial starts with an open disposable database containing 10,000 historical stories. Batches contain distinct URLs, feed-like headlines, timestamps, comment URLs, and a source tag. Each source also receives its usual group tag through the actual AppRuntime.processStoryInput path. Five repetitions use separate databases. Six-source trials start their source ingestion together, representing coincident source-load completion. All source URLs are distinct; shared-URL serialization is not exercised.

30 stories represents a front-page-sized batch; 100 and 300 represent larger feeds or aggregated sources. 1,000 per source is a stress case, not a claim about typical feed size. Data is synthetic and these sizes have not been calibrated against the user’s configured feeds.

- Cold: new incoming URLs, with the historical archive already present. This is first ingestion, not cold process startup or an empty operating-system disk cache.
- Warm unchanged: identical input immediately after cold ingestion, retaining the runtime working set.
- Warm changed: same URLs with an additional tag, forcing a document update for every story.

Timing covers filtering, group-tag insertion, bulk URL lookup, working-set merge, save completion, and synchronous event publication. It excludes database creation, archive seeding, input construction, feed fetch/parsing, UI rendering, replication, and content attachments. The platform uses fake settings/network/event consumers and the real story store and real database adapter.

Peak database operations counts unresolved application-level get/put/allDocs promises; it does not count physical disk transactions or PouchDB’s internal calls. Timer lag is excess delay of a 10 ms interval and is indicative of event-loop pressure, not a measured UI frame time. Instrumentation adds some overhead.

## Chromium / IndexedDB

PouchDB 9 browser IndexedDB with LOCAL_POUCH_OPTIONS; headless Chromium, not Electron.

Runtime: 147.0.7727.15. 120 timed samples.

| Stories/source | Sources | Total | Cold ms | Warm unchanged ms | Warm changed ms | Peak DB promises cold / changed |
|---:|---:|---:|---:|---:|---:|---:|
| 30 | 1 | 30 | 86.5 | 3.4 | 75.6 | 30 / 30 |
| 30 | 6 | 180 | 361.6 | 17.0 | 336.8 | 180 / 180 |
| 100 | 1 | 100 | 199.2 | 10.9 | 182.3 | 100 / 100 |
| 100 | 6 | 600 | 1026.5 | 58.4 | 718.6 | 600 / 600 |
| 300 | 1 | 300 | 439.2 | 30.5 | 301.4 | 300 / 300 |
| 300 | 6 | 1800 | 2840.3 | 194.0 | 2076.4 | 1800 / 1800 |
| 1000 | 1 | 1000 | 1548.8 | 101.1 | 990.2 | 1000 / 1000 |
| 1000 | 6 | 6000 | 7167.4 | 404.9 | 9673.9 | 6000 / 6000 |

Values are medians of five trials. Raw JSON retains each trial, operation counts, peak save concurrency, elapsed time and timer lag.

| Six sources, stories/source | Phase | Min–max ms | Median timer lag ms | Maximum timer lag ms |
|---:|---|---:|---:|---:|
| 30 | cold | 224.1–898.6 | 14.5 | 16.2 |
| 30 | warm | 13.9–36.9 | 0.9 | 12.2 |
| 30 | warmChanged | 187.8–814.1 | 10.5 | 18.4 |
| 100 | cold | 602.8–2038.7 | 43.1 | 52.3 |
| 100 | warm | 53.5–262.9 | 11.6 | 22.5 |
| 100 | warmChanged | 580.6–1311.1 | 55.9 | 60.4 |
| 300 | cold | 1289.8–6578.7 | 132.5 | 190.2 |
| 300 | warm | 113.3–263.4 | 68.5 | 80.2 |
| 300 | warmChanged | 1874.6–4891.7 | 147.2 | 205.0 |
| 1000 | cold | 6989.1–10451.6 | 532.5 | 615.3 |
| 1000 | warm | 388.2–472.8 | 207.3 | 300.6 |
| 1000 | warmChanged | 9524.4–11032.3 | 419.4 | 463.4 |

## Node / LevelDB baseline

PouchDB 9 LevelDB (Node); Electron uses IndexedDB, so timings are not renderer timings.

Runtime: v24.13.1. 120 timed samples.

| Stories/source | Sources | Total | Cold ms | Warm unchanged ms | Warm changed ms | Peak DB promises cold / changed |
|---:|---:|---:|---:|---:|---:|---:|
| 30 | 1 | 30 | 20.3 | 5.4 | 12.5 | 30 / 30 |
| 30 | 6 | 180 | 58.3 | 20.3 | 79.4 | 180 / 180 |
| 100 | 1 | 100 | 46.4 | 9.6 | 33.5 | 100 / 100 |
| 100 | 6 | 600 | 177.9 | 57.9 | 208.2 | 600 / 600 |
| 300 | 1 | 300 | 92.0 | 32.5 | 97.1 | 300 / 300 |
| 300 | 6 | 1800 | 431.8 | 167.2 | 633.7 | 1800 / 1800 |
| 1000 | 1 | 1000 | 209.3 | 76.1 | 278.3 | 1000 / 1000 |
| 1000 | 6 | 6000 | 1591.5 | 458.5 | 2015.7 | 6000 / 6000 |

Values are medians of five trials. Raw JSON retains each trial, operation counts, peak save concurrency, elapsed time and timer lag.

| Six sources, stories/source | Phase | Min–max ms | Median timer lag ms | Maximum timer lag ms |
|---:|---|---:|---:|---:|
| 30 | cold | 53.6–91.1 | 8.7 | 14.1 |
| 30 | warm | 17.2–34.5 | 7.4 | 15.5 |
| 30 | warmChanged | 71.1–130.0 | 12.4 | 18.5 |
| 100 | cold | 140.5–1140.8 | 13.8 | 44.1 |
| 100 | warm | 48.2–86.9 | 14.9 | 38.7 |
| 100 | warmChanged | 184.4–748.5 | 27.6 | 44.7 |
| 300 | cold | 375.0–680.2 | 57.7 | 68.9 |
| 300 | warm | 133.1–224.2 | 57.6 | 83.7 |
| 300 | warmChanged | 497.1–1078.7 | 97.9 | 156.3 |
| 1000 | cold | 1186.8–1751.3 | 240.3 | 275.9 |
| 1000 | warm | 451.5–594.9 | 196.2 | 246.0 |
| 1000 | warmChanged | 1711.2–3787.3 | 342.9 | 382.6 |

## Interpretation and limits

Every cold or changed trial performs exactly one bulk lookup per source plus one document get and one document put per incoming story. Unchanged warm trials perform only the bulk lookups and no saves. Assertions check these counts and the final document count for every sample.

The six-source limit does not bound per-story saves: the measured peak reaches the entire incoming story count for both adapters in every cold and changed configuration. A single 1,000-story source reaches 1,000 concurrent save promises, and six such sources reach 6,000. This establishes fan-out and its cost, but does not establish that a concurrency cap would be faster. A follow-up should compare a shared ingestion limit across all six sources against this baseline.

In IndexedDB, six sources with 100 stories each take a median 1.03 seconds cold and 0.72 seconds with tag updates; at 300 each those values reach 2.84 and 2.08 seconds. The 6,000-story stress case takes 7.17 seconds cold and 9.67 seconds with updates, versus 0.40 seconds unchanged. Median maximum timer delay per trial reaches 533 ms cold and 419 ms with updates in that stress case. Results vary substantially: six-source 300-story cold trials range from 1.29 to 6.58 seconds. Treat these as host-specific baseline measurements rather than precise latency guarantees.

IndexedDB results use the application’s auto_compaction=true and revs_limit=20 options in an isolated headless Chromium profile served from localhost. They exercise the same persistence adapter family as Electron, but exclude Electron integration and the rendered story list. Node uses default LevelDB options and is a supplemental baseline; cross-adapter timing differences also reflect these option and runtime differences.

The archive size is fixed, so these measurements do not establish scaling with large user archives. Warm refreshes containing feed content, comment changes, duplicate URLs, or new stories can behave differently. Run a captured-feed workload and a bounded-concurrency comparison before choosing a production limit.

## Reproduce

```powershell
npm run build:packages
node scripts/benchmark-story-ingestion.js
node scripts/benchmark-story-ingestion-browser.js
node scripts/summarize-story-ingestion.js
```

On Windows, run unattended browser work using the hidden-desktop workflow. The browser runner uses an ephemeral profile and origin, destroys each benchmark database, removes its temporary bundle, and checkpoints JSON after every trial. User databases are never opened.

## Harness issues encountered

The first Node instrumentation attempt wrapped the live PouchDB instance, interfering with its internal callback calls and producing a 404/unhandled rejection. The corrected harness wraps only the store-facing database interface. The first browser bundle exposed PouchDB through a default export; the harness now handles both module export shapes. Both full corrected runs must succeed before this report is generated. Node also reports a dependency punycode deprecation warning; it does not fail the run.
