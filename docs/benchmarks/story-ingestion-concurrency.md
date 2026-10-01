# Shared story ingestion concurrency experiment

Run started 2026-10-01T15:06:44.035Z. 240 timed samples in Chromium 147.0.7727.15.

The actual AppRuntime ingestion path and PouchStoryStore run against PouchDB IndexedDB with LOCAL_POUCH_OPTIONS. An experimental FIFO gate wraps the complete addStory operation, using one gate per runtime shared across all six simultaneous source batches. The existing per-URL write queue remains in place. Bulk URL lookups remain outside the gate, so peak database promises can exceed the story limit by up to the number of source lookups.

Strategies: unbounded, 16, 64, and 256 concurrent story operations. Five repetitions per strategy and size use separate disposable databases, each seeded with 10,000 historical stories. Strategy order rotates each repetition. The unbounded baseline is remeasured in the same run with the same instrumentation.

Cold inserts new URLs; warm unchanged repeats them with the same runtime; warm changed adds one tag to every story. Synthetic batches contain distinct feed-like URLs, headlines, timestamps, comments and source/group tags. 30–300 stories per source represent front pages through larger feeds; 1,000 is a stress case. These sizes are not calibrated against configured feeds.

Timing excludes feed fetch/parsing, input construction, database creation/seeding, rendering, replication and content attachments. Timer lag is the largest excess delay of a 10 ms interval per trial. It indicates event-loop pressure rather than actual UI frame latency. Chromium runs unattended on a hidden desktop with an ephemeral profile and localhost origin.

## Median timings

| Stories/source | Total | Shared limit | Cold ms | Warm unchanged ms | Warm changed ms |
|---:|---:|---:|---:|---:|---:|
| 30 | 180 | unbounded | 308.6 | 20.3 | 360.3 |
| 30 | 180 | 16 | 324.0 | 20.8 | 367.3 |
| 30 | 180 | 64 | 310.7 | 17.2 | 349.2 |
| 30 | 180 | 256 | 292.2 | 19.1 | 375.4 |
| 100 | 600 | unbounded | 899.7 | 56.3 | 643.5 |
| 100 | 600 | 16 | 988.4 | 70.0 | 1342.2 |
| 100 | 600 | 64 | 1019.4 | 61.3 | 709.2 |
| 100 | 600 | 256 | 909.1 | 64.1 | 716.8 |
| 300 | 1800 | unbounded | 3123.3 | 154.0 | 2183.6 |
| 300 | 1800 | 16 | 2833.3 | 161.2 | 1986.0 |
| 300 | 1800 | 64 | 2778.9 | 149.3 | 1872.9 |
| 300 | 1800 | 256 | 3028.8 | 168.1 | 1861.2 |
| 1000 | 6000 | unbounded | 7139.2 | 425.7 | 9530.6 |
| 1000 | 6000 | 16 | 10576.5 | 442.8 | 7006.5 |
| 1000 | 6000 | 64 | 6323.8 | 410.3 | 6662.8 |
| 1000 | 6000 | 256 | 11160.3 | 404.5 | 6330.4 |

## Throughput, event-loop pressure and observed concurrency

Time change is relative to the freshly measured unbounded median at the same size and phase; negative means faster. Timer lag is the median of each trial’s maximum delay. Peaks are the maximum across five trials.

| Stories/source | Phase | Limit | Time change | Min–max ms | Median max timer lag ms | Peak story operations | Peak saves | Peak DB promises |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 30 | cold | unbounded | 0.0% | 207.3–640.2 | 15.8 | 180 | 180 | 180 |
| 30 | cold | 16 | 5.0% | 283.0–726.4 | 1.5 | 16 | 16 | 21 |
| 30 | cold | 64 | 0.7% | 241.7–365.4 | 3.2 | 64 | 64 | 67 |
| 30 | cold | 256 | -5.3% | 252.7–335.2 | 14.3 | 180 | 180 | 180 |
| 30 | warm | unbounded | 0.0% | 15.6–28.7 | 1.6 | 30 | 0 | 6 |
| 30 | warm | 16 | 2.5% | 18.3–184.2 | 3.7 | 16 | 0 | 6 |
| 30 | warm | 64 | -15.3% | 17.2–24.0 | 1.5 | 30 | 0 | 6 |
| 30 | warm | 256 | -5.9% | 18.4–22.7 | 1.2 | 30 | 0 | 6 |
| 30 | warmChanged | unbounded | 0.0% | 182.6–448.2 | 7.9 | 180 | 180 | 180 |
| 30 | warmChanged | 16 | 1.9% | 338.7–1040.5 | 2.1 | 16 | 16 | 21 |
| 30 | warmChanged | 64 | -3.1% | 333.6–451.2 | 3.1 | 64 | 64 | 67 |
| 30 | warmChanged | 256 | 4.2% | 365.8–415.0 | 7.8 | 180 | 180 | 180 |
| 100 | cold | unbounded | 0.0% | 694.7–962.7 | 29.7 | 600 | 600 | 600 |
| 100 | cold | 16 | 9.9% | 664.9–3427.1 | 7.9 | 16 | 16 | 21 |
| 100 | cold | 64 | 13.3% | 717.1–1139.7 | 5.8 | 64 | 64 | 69 |
| 100 | cold | 256 | 1.0% | 816.6–1085.2 | 18.8 | 256 | 256 | 259 |
| 100 | warm | unbounded | 0.0% | 55.0–84.2 | 6.4 | 100 | 0 | 6 |
| 100 | warm | 16 | 24.3% | 57.7–260.9 | 8.3 | 16 | 0 | 6 |
| 100 | warm | 64 | 8.9% | 51.4–62.0 | 7.1 | 64 | 0 | 6 |
| 100 | warm | 256 | 13.9% | 50.7–73.5 | 11.0 | 100 | 0 | 6 |
| 100 | warmChanged | unbounded | 0.0% | 562.0–708.8 | 34.5 | 600 | 600 | 600 |
| 100 | warmChanged | 16 | 108.6% | 1184.8–3200.2 | 13.7 | 16 | 16 | 21 |
| 100 | warmChanged | 64 | 10.2% | 654.3–1869.0 | 13.2 | 64 | 64 | 69 |
| 100 | warmChanged | 256 | 11.4% | 577.2–1229.7 | 24.0 | 256 | 256 | 259 |
| 300 | cold | unbounded | 0.0% | 1978.2–3246.9 | 121.6 | 1800 | 1800 | 1800 |
| 300 | cold | 16 | -9.3% | 2589.6–4556.1 | 31.4 | 16 | 16 | 21 |
| 300 | cold | 64 | -11.0% | 2647.8–3161.8 | 30.7 | 64 | 64 | 69 |
| 300 | cold | 256 | -3.0% | 2728.3–5587.8 | 33.6 | 256 | 256 | 261 |
| 300 | warm | unbounded | 0.0% | 139.8–166.2 | 44.6 | 300 | 0 | 6 |
| 300 | warm | 16 | 4.7% | 144.5–407.7 | 46.5 | 16 | 0 | 6 |
| 300 | warm | 64 | -3.1% | 145.1–180.2 | 41.1 | 64 | 0 | 6 |
| 300 | warm | 256 | 9.2% | 130.9–205.5 | 51.1 | 256 | 0 | 6 |
| 300 | warmChanged | unbounded | 0.0% | 1746.2–2270.6 | 111.1 | 1800 | 1800 | 1800 |
| 300 | warmChanged | 16 | -9.0% | 1668.2–2220.0 | 47.9 | 16 | 16 | 21 |
| 300 | warmChanged | 64 | -14.2% | 1684.0–2113.9 | 43.9 | 64 | 64 | 69 |
| 300 | warmChanged | 256 | -14.8% | 1688.0–3449.7 | 50.6 | 256 | 256 | 261 |
| 1000 | cold | unbounded | 0.0% | 5545.7–7319.9 | 464.0 | 6000 | 6000 | 6000 |
| 1000 | cold | 16 | 48.1% | 6446.6–13022.7 | 173.7 | 16 | 16 | 21 |
| 1000 | cold | 64 | -11.4% | 5876.3–13808.0 | 124.6 | 64 | 64 | 69 |
| 1000 | cold | 256 | 56.3% | 6422.2–11776.0 | 124.3 | 256 | 256 | 261 |
| 1000 | warm | unbounded | 0.0% | 366.9–490.2 | 177.3 | 1000 | 0 | 6 |
| 1000 | warm | 16 | 4.0% | 404.3–496.6 | 152.6 | 16 | 0 | 6 |
| 1000 | warm | 64 | -3.6% | 386.9–470.5 | 164.9 | 64 | 0 | 6 |
| 1000 | warm | 256 | -5.0% | 399.0–448.2 | 160.7 | 256 | 0 | 6 |
| 1000 | warmChanged | unbounded | 0.0% | 9203.2–9628.8 | 400.0 | 6000 | 6000 | 6000 |
| 1000 | warmChanged | 16 | -26.5% | 6421.2–9274.6 | 193.8 | 16 | 16 | 21 |
| 1000 | warmChanged | 64 | -30.1% | 6133.2–7163.3 | 186.9 | 64 | 64 | 69 |
| 1000 | warmChanged | 256 | -33.6% | 6107.7–21826.2 | 171.4 | 256 | 256 | 261 |

## Assessment

A shared limit of 64 is the most promising balance among the tested values, rather than an established optimum. At 1,800 stories it reduces median cold/changed elapsed time by 11%/14% and median maximum timer lag by 75%/60%. At 6,000 stories it reduces median elapsed time by 11%/30% and timer lag by 73%/53%. At 600 stories it costs 13%/10% elapsed time while reducing timer lag by 80%/62%. At 180 stories throughput is close to unchanged and timer lag is lower.

A limit of 16 has a large changed-ingestion slowdown at 600 stories and a cold slowdown in the stress case. A limit of 256 is slightly faster for changed ingestion in the stress-case median, but has a slower cold median and a changed-ingestion outlier of 21.8 seconds. The limit of 64 also has a cold stress outlier of 13.8 seconds, so none of these measurements demonstrates predictable tail latency. Five repetitions are sufficient for this exploratory comparison, not a statistically established production optimum.

The story/save peak is 64 across all write-heavy configurations with the 64 strategy. Database-operation peaks reach 69 because other source bulk lookups can overlap those operations. Warm unchanged refreshes show little consistent benefit, and their bulk lookup/deserialization work remains outside the gate. A production implementation should target ingestion only, retain per-URL serialization, and validate mixed new/existing content and conflicts before rollout.

## Validation and limits

Every sample asserts one bulk lookup per source and one get/put per story for cold and changed ingestion, with no saves in unchanged warm ingestion. It checks final document count, an updated persisted tag, the story/save concurrency limit, and an empty drained gate. Build and syntax checks also passed.

This tests the performance of a shared gate, not a production implementation. No production application source was modified. Warm unchanged operations do not necessarily yield to a browser task, so a promise gate alone cannot guarantee responsive rendering. Archive size is fixed; shared URLs, conflicts, content attachments and active replication need separate coverage before shipping a limiter. Timing variance and host load limit precise latency conclusions.

## Reproduce

```powershell
npm run build:packages
node scripts/benchmark-story-ingestion-browser.js --concurrency
node scripts/summarize-story-ingestion-concurrency.js
```

Use the hidden-desktop workflow for unattended Windows browser runs. Raw results are checkpointed after each strategy/trial to story-ingestion-concurrency.json. The original unbounded benchmark artifacts are preserved.

A progress-only diagnostic query had an extra closing parenthesis and was corrected. It did not affect the running benchmark. No benchmark assertion or runtime errors occurred in this experiment.
