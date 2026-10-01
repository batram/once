# Further story ingestion optimization experiments

The production ingestion limit and related fixes were committed as f59b5f6a. These follow-up experiments modify only benchmark scripts; production application code remains at that commit.

Both experiments use the actual AppRuntime and PouchStoryStore with the native shared limit of 64, PouchDB IndexedDB and LOCAL_POUCH_OPTIONS, six simultaneous sources, disposable databases containing 10,000 historical stories, and three repetitions per strategy and size. Strategy order rotates between repetitions. Cold inserts new URLs; warm repeats unchanged input; warmChanged changes a tag and, in the content experiment, the feed body. Timings exclude input construction, database seeding, fetching/parsing, and UI rendering. Chromium runs headless on a hidden desktop.

## Combining metadata and feed-content saves

Run: 2026-10-01T15:42:52.687Z; Chromium 147.0.7727.15; 36 timed samples.

Cold feed content contains about 4 KiB of ASCII HTML per story; updates contain about 8 KiB and one new tag. Bodies are identical within a phase, so attachment deduplication may make absolute timings optimistic relative to distinct real articles. The experimental coalesced strategy defers a metadata-only save when a subsequent feed-content save will persist that metadata. Page-extracted content and updates that do not improve feed content are not deferred. This is a benchmark-only prototype, not a production event/rollback design.

| Stories/source | Total | Phase | Strategy | Median elapsed ms | Min–max ms | Median maximum timer lag ms | Median slowest source lookup ms | Document reads | Document writes | Attachment writes | Bulk lookups |
|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 600 | cold | current | 1993.9 | 1817.8–3401.6 | 23.4 | 17.6 | 1200 | 600 | 600 | 6 |
| 100 | 600 | cold | coalesced | 2514.2 | 2503.5–2670.5 | 22.1 | 12.4 | 1200 | 600 | 600 | 6 |
| 100 | 600 | warm | current | 61.1 | 57.4–81.0 | 7.0 | 50.5 | 0 | 0 | 0 | 6 |
| 100 | 600 | warm | coalesced | 61.2 | 52.1–78.1 | 3.9 | 53.1 | 0 | 0 | 0 | 6 |
| 100 | 600 | warmChanged | current | 6527.9 | 5961.2–6616.3 | 20.7 | 35.8 | 1800 | 1200 | 600 | 6 |
| 100 | 600 | warmChanged | coalesced | 4401.3 | 4086.1–5190.0 | 20.4 | 38.0 | 1200 | 600 | 600 | 6 |
| 300 | 1800 | cold | current | 8459.3 | 7821.7–15375.6 | 33.2 | 37.1 | 3600 | 1800 | 1800 | 6 |
| 300 | 1800 | cold | coalesced | 7812.4 | 6140.5–8350.7 | 31.4 | 39.4 | 3600 | 1800 | 1800 | 6 |
| 300 | 1800 | warm | current | 169.2 | 156.6–202.9 | 25.0 | 134.2 | 0 | 0 | 0 | 6 |
| 300 | 1800 | warm | coalesced | 180.7 | 148.1–206.0 | 27.9 | 148.8 | 0 | 0 | 0 | 6 |
| 300 | 1800 | warmChanged | current | 33809.9 | 32888.1–34602.8 | 24.5 | 97.7 | 5400 | 3600 | 1800 | 6 |
| 300 | 1800 | warmChanged | coalesced | 22838.5 | 22136.0–24487.1 | 37.7 | 146.6 | 3600 | 1800 | 1800 | 6 |

Source lookup durations include storage waiting and time spent behind other source activity; they are not isolated deserialization CPU measurements. The 10 ms timer measures event-loop pressure rather than Electron UI frame time. Every sample validates database operation counts, final document count, updated tags, capacity/drainage, and (for content workloads) the stored attachment body.

## Chunked bulk URL lookups

Run: 2026-10-01T15:48:17.538Z; Chromium 147.0.7727.15; 36 timed samples.

The chunked128 strategy reads each source's URLs in consecutive groups of 128 and yields via setTimeout(0) between groups. It merges all results before ingestion, retains fresh database reads and preserves source output order. The current strategy uses one bulk lookup per source. No resident-story lookup is skipped.

| Stories/source | Total | Phase | Strategy | Median elapsed ms | Min–max ms | Median maximum timer lag ms | Median slowest source lookup ms | Document reads | Document writes | Attachment writes | Bulk lookups |
|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 300 | 1800 | cold | current | 2741.4 | 1986.0–2787.8 | 28.6 | 36.5 | 1800 | 1800 | 0 | 6 |
| 300 | 1800 | cold | chunked128 | 2736.0 | 1637.2–2914.7 | 19.4 | 41.2 | 1800 | 1800 | 0 | 18 |
| 300 | 1800 | warm | current | 158.1 | 156.6–195.9 | 46.6 | 141.2 | 0 | 0 | 0 | 6 |
| 300 | 1800 | warm | chunked128 | 153.3 | 137.9–158.4 | 29.4 | 143.7 | 0 | 0 | 0 | 18 |
| 300 | 1800 | warmChanged | current | 1782.1 | 1576.6–4387.2 | 48.2 | 82.9 | 1800 | 1800 | 0 | 6 |
| 300 | 1800 | warmChanged | chunked128 | 1705.0 | 1648.0–1711.1 | 29.0 | 98.7 | 1800 | 1800 | 0 | 18 |
| 1000 | 6000 | cold | current | 6152.9 | 5777.0–10698.4 | 119.7 | 114.2 | 6000 | 6000 | 0 | 6 |
| 1000 | 6000 | cold | chunked128 | 6194.7 | 5609.3–10663.9 | 74.1 | 180.4 | 6000 | 6000 | 0 | 48 |
| 1000 | 6000 | warm | current | 373.2 | 363.5–397.9 | 159.5 | 335.7 | 0 | 0 | 0 | 6 |
| 1000 | 6000 | warm | chunked128 | 365.0 | 349.7–381.3 | 71.5 | 327.3 | 0 | 0 | 0 | 48 |
| 1000 | 6000 | warmChanged | current | 6044.1 | 5969.7–6198.1 | 153.5 | 318.7 | 6000 | 6000 | 0 | 6 |
| 1000 | 6000 | warmChanged | chunked128 | 5801.0 | 5670.6–6137.7 | 68.9 | 302.3 | 6000 | 6000 | 0 | 48 |

Source lookup durations include storage waiting and time spent behind other source activity; they are not isolated deserialization CPU measurements. The 10 ms timer measures event-loop pressure rather than Electron UI frame time. Every sample validates database operation counts, final document count, updated tags, capacity/drainage, and (for content workloads) the stored attachment body.

## Findings

Combining metadata/content saves reduces median updated ingestion from 6.53 to 4.40 seconds at 600 stories and from 33.81 to 22.84 seconds at 1,800 stories, approximately 32.6% and 32.4% faster. It halves document writes and removes one of three application-level document reads per updated story. Attachment writes remain unchanged. Timer delay does not improve consistently; this is primarily a throughput opportunity. Cold ingestion has the same operation counts under both strategies, so its timing differences should not be attributed to write combining.

Chunking reduces unchanged-warm median maximum timer delay from 46.6 to 29.4 ms at 1,800 stories and from 159.5 to 71.5 ms at 6,000 stories, approximately 37% and 55% lower. Median elapsed time stays close: 158.1 versus 153.3 ms and 373.2 versus 365.0 ms. Bulk requests increase from 6 to 18 or 48. The small elapsed-time differences are not strong evidence of faster throughput with only three repetitions; the more substantial signal is reduced event-loop delay.

## Decision and scope

On 2026-10-01, the decision was to defer both optimizations. The measured benefits do not justify implementing them at this point. Preserve this report and the raw measurements for future reference; remove the temporary experiment code. The shared production ingestion limit of 64 and its related fixes remain in commit f59b5f6a.

The content prototype isolates the avoidable read/write pair. A production implementation must prepare tag/comment/content changes together, retain sync-state reconciliation and attachment stubs, and define rollback and event timing when the combined save fails. It must continue protecting page-extracted articles. Three repetitions and synthetic content are exploratory evidence, not a production latency guarantee.

Lookup chunking is a separate tradeoff between more database requests, task yields, and reduced timer delay. Warm unchanged workloads are the primary comparison because they avoid save work. Skipping reads entirely is not justified by this experiment: resident stories must still reflect persisted changes and reconciliation.

Neither prototype was applied to production. The experimental harness extensions and report-generation script were removed during repository cleanup. The established baseline, concurrency-comparison, and production-validation benchmark modes remain available.

## Archived evidence

The raw samples and runtime metadata are retained in story-ingestion-content-experiment.json and story-ingestion-lookup-experiment.json beside this report. The temporary --content-experiment and --lookup-experiment runner modes are no longer present. Recreating the experiments requires adding the benchmark-only strategies described above to the existing browser harness.

The original runs used the hidden-desktop workflow, checkpointed JSON after each strategy/trial, and cleaned up temporary profiles, databases, and bundles. User databases were never opened.
